import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, stat, chmod, rm, symlink, truncate } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { executeRemoteSshTask } from '../src/lib/remote-harness/ssh-executor';
import { piSizeProbeCommand, withRemotePiSessionSize } from '../src/lib/remote-harness/ssh-session-size';

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'ssh-size-'));
  const originalPath = process.env.PATH;
  const dir = path.join(root, "native ' $literal"), record = path.join(dir, 'native.jsonl');
  const samples: { totalBytes: number; deltaBytes?: number }[] = [];
  const header = JSON.stringify({ type: 'session', id: 'native' }) + '\n';
  const read = async () => execFileSync('bash', ['-c', piSizeProbeCommand(dir)], { encoding: 'utf8' });
  const publish = (size: { totalBytes: number; deltaBytes?: number }) => { samples.push(size); };
  try {
    await withRemotePiSessionSize({ read, nativeSessionId: () => 'native', publish, execute: async () => {
      await mkdir(dir); await writeFile(record, header); await writeFile(path.join(dir, 'log.txt'), 'ignore');
    } });
    assert.equal(samples.at(-1)?.totalBytes, (await stat(record)).size);
    assert.equal(samples.at(-1)?.deltaBytes, Buffer.byteLength(header));
    await withRemotePiSessionSize({ read, nativeSessionId: () => 'native', publish, execute: async () => { await appendFile(record, 'data'); } });
    assert.equal(samples.at(-1)?.deltaBytes, 4);
    await withRemotePiSessionSize({ read, nativeSessionId: () => 'native', publish, execute: async () => { await writeFile(record, header); } });
    assert.equal(samples.at(-1)?.deltaBytes, undefined);
    await truncate(record, 256 * 1024 ** 2);
    assert.equal(JSON.parse(await read()).bytes, 256 * 1024 ** 2);
    await symlink(record, path.join(dir, 'alias.jsonl')); assert.equal(JSON.parse(await read()), null);
    await rm(path.join(dir, 'alias.jsonl')); await writeFile(record, header);
    assert.match(Buffer.from(piSizeProbeCommand('C:\\native', true).split(' ').at(-1)!, 'base64').toString('utf16le'), /^& node -e /);

    // Real SSH executor lifecycle, transport fixture executes the actual read-only probe command.
    const ssh = path.join(root, 'ssh');
    await writeFile(ssh, `#!${process.execPath}
const fs=require('fs'),cp=require('child_process');const command=process.argv.at(-1);
fs.readFileSync(0);
if(command.includes('__ACPX_PREFLIGHT')) {
  fs.appendFileSync(${JSON.stringify(record)},'abcd');
  if(process.env.SSH_SIZE_NO_ID!=='1') console.log(JSON.stringify({type:'session',id:'native'}));
  console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}]}}));
  process.exit(process.env.SSH_SIZE_FAIL==='1'?1:0);
}
const r=cp.spawnSync('bash',['-c',command],{encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status||0);
`);
    await chmod(ssh, 0o755); process.env.PATH = root + ':' + originalPath;
    const options = { timeout: 5000, harnessType: 'pi-agent', resumeSessionId: dir,
      host: { id: 'fixture', label: 'fixture', host: 'fixture', port: 22, sshUser: 'fixture', authType: 'ssh_key', privateKey: 'fixture', workingDirectory: null, status: 'online', viaNetwork: 'test', supportedHarnesses: ['pi-agent'] },
      onSessionSize: async (sessionId: string, size: { totalBytes: number; deltaBytes?: number }) => { assert.equal(sessionId, dir); publish(size); },
    };
    await writeFile(path.join(dir, 'old.jsonl'), JSON.stringify({ type: 'session', id: 'old' }) + '\n' + 'x'.repeat(20000));
    assert.equal((await executeRemoteSshTask({ id: 'fixture', name: 'fixture' }, options)).output, 'done');
    assert.equal(samples.at(-1)?.deltaBytes, 4);
    assert.equal(samples.at(-1)?.totalBytes, (await stat(record)).size, 'current session must exclude old histories');
    process.env.SSH_SIZE_FAIL = '1';
    const count = samples.length;
    await assert.rejects(executeRemoteSshTask({ id: 'fixture', name: 'fixture' }, options), /ssh exited/);
    assert.equal(samples.length, count + 1, 'failed native run still samples');
    assert.equal(samples.at(-1)?.deltaBytes, 4);
    delete process.env.SSH_SIZE_FAIL;
    assert.equal((await executeRemoteSshTask({ id: 'fixture', name: 'fixture' }, { ...options, onSessionSize: () => { throw Error('telemetry'); } })).output, 'done');
    assert.equal(await withRemotePiSessionSize({ read: async () => { throw Error('unavailable'); }, nativeSessionId: () => 'native', publish, execute: async () => 'ok' }), 'ok');
    const beforeUnknown = samples.length;
    process.env.SSH_SIZE_NO_ID = '1';
    assert.equal((await executeRemoteSshTask({ id: 'fixture', name: 'fixture' }, options)).output, 'done');
    delete process.env.SSH_SIZE_NO_ID;
    for (const nativeId of [undefined, 'not-present']) {
      assert.equal(await withRemotePiSessionSize({ read, nativeSessionId: () => nativeId, publish, execute: async () => 'ok' }), 'ok');
      await assert.rejects(withRemotePiSessionSize({ read, nativeSessionId: () => nativeId, publish, execute: async () => { throw Error('native failed'); } }), /native failed/);
    }
    await writeFile(path.join(dir, 'duplicate.jsonl'), header);
    assert.equal(await withRemotePiSessionSize({ read, nativeSessionId: () => 'native', publish, execute: async () => 'ok' }), 'ok');
    assert.equal(samples.length, beforeUnknown, 'unknown or ambiguous identity must not publish directory totals');
    await rm(path.join(dir, 'duplicate.jsonl'));
    await withRemotePiSessionSize({ read, nativeSessionId: () => 'native', publish, execute: async () => {
      await appendFile(record, 'data'); await appendFile(path.join(dir, 'old.jsonl'), 'unrelated history');
    } });
    assert.equal(samples.at(-1)?.deltaBytes, 4, 'other histories must not affect growth');
    console.log('Remote SSH Pi size: real probe, executor/resume/failure, growth, truncation, sparse files, quoting, symlink and nonfatal telemetry passed');
  } finally { process.env.PATH = originalPath; delete process.env.SSH_SIZE_FAIL; delete process.env.SSH_SIZE_NO_ID; await rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
