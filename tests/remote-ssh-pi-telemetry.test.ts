import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import * as hosts from '../src/lib/remote-harness/hosts';
import { piSizeProbeCommand } from '../src/lib/remote-harness/ssh-session-size';
import { prisma } from '../src/lib/prisma';
import { executeViaRemoteSshHarness } from '../src/lib/acpx/runner-harness';
import { collectLiveRoomFootnotes } from '../src/lib/live-room-footnotes';
import type { AcpxParticipantRequest } from '../src/lib/acpx/types';
import { executeRemoteSshTask } from '../src/lib/remote-harness/ssh-executor';

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'ssh-pi-telemetry-'));
  const session = path.join(root, 'session'), file = path.join(session, 'native.jsonl');
  const previous = { path: process.env.PATH, data: process.env.XDG_DATA_HOME };
  const managedBin = path.join(root, 'data/pi-node/current/bin');
  await mkdir(managedBin, { recursive: true });
  const marker = path.join(root, 'managed-node-used');
  await writeFile(path.join(managedBin, 'node'), `#!/bin/sh\nprintf used >> '${marker}'\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  process.env.XDG_DATA_HOME = path.join(root, 'data');
  const ssh = path.join(root, 'ssh');
  await writeFile(ssh, `#!${process.execPath}
const fs=require('fs'),cp=require('child_process');const command=process.argv.at(-1);fs.readFileSync(0);
if(!command.includes('__ACPX_PREFLIGHT')) {
 const r=cp.spawnSync('bash',['-c',command],{encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status||0);
}
const dir=${JSON.stringify(session)},file=${JSON.stringify(file)};
fs.mkdirSync(dir,{recursive:true});
const existing=fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\\n').map(JSON.parse):[];
if(!existing.length) fs.writeFileSync(file,JSON.stringify({type:'session',id:'native'})+'\\n');
let parent=existing.at(-1)?.id||null;const serial=String(Date.now());
const entries=[['thinking_level_change',{thinkingLevel:'off'}],['message',{message:{role:'user',content:'PRIVATE PROMPT'}}],['message',{message:{role:'assistant',model:'actual-model',provider:'actual-provider',stopReason:'stop',content:'PRIVATE ANSWER',usage:{input:100,output:20,cacheRead:30,cacheWrite:10}}}]];
for(let i=0;!process.env.SSH_PI_STALE && i<entries.length;i++){const [type,extra]=entries[i],id=serial+'-'+i;fs.appendFileSync(file,JSON.stringify({type,id,parentId:parent,timestamp:new Date().toISOString(),...extra})+'\\n');parent=id;}
console.log(JSON.stringify({type:'session',id:process.env.SSH_PI_WRONG_ID?'wrong':'native'}));
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}]}}));
`);
  await chmod(ssh, 0o755); process.env.PATH = root + ':' + previous.path;
  try {
    const sizes: { totalBytes: number; deltaBytes?: number }[] = [];
    const host = { id: 'fixture', label: 'fixture', host: 'fixture', port: 22, sshUser: 'fixture', authType: 'ssh_key', privateKey: 'fixture', workingDirectory: null, status: 'online', viaNetwork: 'test', supportedHarnesses: ['pi-agent'] };
    const run = (executionId: string) => executeRemoteSshTask({ id: 'fixture', name: 'fixture' }, {
      timeout: 5000, harnessType: 'pi-agent', host, resumeSessionId: session, executionId,
      onSessionSize: (_id, size) => { sizes.push(size); },
    });
    const first = await run('first');
    assert.equal(first.output, 'done');
    assert.equal(first.runtimeState?.model, 'actual-model', 'SSH must return confirmed native model');
    assert.equal(first.runtimeState?.executionId, 'first');
    assert.deepEqual(first.runtimeState?.reasoning, { kind: 'level', value: 'off' });
    assert.equal(first.contextUsage?.usedTokens, 140);
    assert.equal(first.contextUsage?.outputTokens, 20);
    assert.equal(first.contextUsage?.totalTokens, 160);
    const second = await run('second');
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.runtimeState?.executionId, 'second');
    assert.notEqual(second.runtimeState?.turnId, first.runtimeState?.turnId);
    assert.equal(second.contextUsage?.totalTokens, 320);
    assert.ok(sizes[1].totalBytes > sizes[0].totalBytes);
    assert.equal(sizes[1].deltaBytes, sizes[1].totalBytes - sizes[0].totalBytes);
    assert.match(await readFile(marker, 'utf8'), /used/, 'probe must reuse Pi managed Node');
    assert.doesNotMatch(JSON.stringify(second), /PRIVATE/);
    const probe = execFileSync('bash', ['-c', piSizeProbeCommand(session, false, 'native')], { encoding: 'utf8' });
    assert.doesNotMatch(probe, /PRIVATE/, 'SSH probe must not transfer message content');
    assert.ok(JSON.parse(probe).files['native.jsonl'].telemetryLines.length);
    const originalHost = hosts.getRemoteHarnessHostById;
    const participantMethods = { findUnique: prisma.taskRunParticipant.findUnique,
      update: prisma.taskRunParticipant.update, updateMany: prisma.taskRunParticipant.updateMany };
    const runMethods = { findUnique: prisma.taskRun.findUnique, update: prisma.taskRun.update };
    let stored = '{}', runStored = '{}';
    const row = () => ({ controlMetadata: stored, harnessType: 'pi-agent' });
    Object.assign(hosts, { getRemoteHarnessHostById: async () => host });
    Object.assign(prisma.taskRunParticipant, {
      findUnique: async () => row(),
      update: async ({ data }: { data: { controlMetadata: string } }) => { stored = data.controlMetadata; return row(); },
      updateMany: async ({ where, data }: { where: { controlMetadata: string }; data: { controlMetadata: string } }) => {
        if (where.controlMetadata !== stored) return { count: 0 };
        stored = data.controlMetadata; return { count: 1 };
      },
    });
    Object.assign(prisma.taskRun, {
      findUnique: async () => ({ controlMetadata: runStored }),
      update: async ({ data }: { data: { controlMetadata: string } }) => { runStored = data.controlMetadata; },
    });
    try {
      const participant: AcpxParticipantRequest = { gatewayId: host.id, executionBackend: 'remote_ssh',
        harnessType: 'pi-agent', role: 'custom', resumeSessionId: session };
      const request = { taskId: 'fixture', taskName: 'fixture', orchestrationMode: 'single' as const, participants: [participant] };
      const execute = () => executeViaRemoteSshHarness(request, 'run', 'participant', participant, {}, [], { transcript: '', latestUserMessage: null });
      for (let i = 0; i < 2; i++) {
        const startedAt = Date.now();
        await execute();
        const notes = (await collectLiveRoomFootnotes({ participantId: 'participant', startedAt })).join('\n');
        assert.match(notes, /actual-model.*思考档位：off/);
        assert.match(notes, /最近一次模型调用输入 140 \/ 输出 20 tokens/);
        assert.match(notes, /会话记录：.*本轮新增：\+/);
        assert.doesNotMatch(notes, /未采集|实际值未确认|遥测缺失/);
      }
      process.env.SSH_PI_STALE = '1';
      const startedAt = Date.now();
      await execute();
      const stale = (await collectLiveRoomFootnotes({ participantId: 'participant', startedAt })).join('\n');
      assert.match(stale, /实际值未确认/);
      assert.match(stale, /上下文：未知/);
      delete process.env.SSH_PI_STALE;
    } finally {
      Object.assign(hosts, { getRemoteHarnessHostById: originalHost });
      Object.assign(prisma.taskRunParticipant, participantMethods);
      Object.assign(prisma.taskRun, runMethods);
    }
    process.env.SSH_PI_WRONG_ID = '1';
    const count = sizes.length;
    const mismatch = await run('mismatch');
    assert.equal(mismatch.runtimeState, undefined);
    assert.equal(mismatch.contextUsage, undefined);
    assert.equal(sizes.length, count, 'wrong native identity must not publish size');
    delete process.env.SSH_PI_WRONG_ID;
    console.log('Remote SSH telemetry: managed Node, two-turn executor/persistence/card, size growth, stale and mismatched sessions passed');
  } finally {
    delete process.env.SSH_PI_STALE; delete process.env.SSH_PI_WRONG_ID;
    process.env.PATH = previous.path;
    if (previous.data === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous.data;
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
