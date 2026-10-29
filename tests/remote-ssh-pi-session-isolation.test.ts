import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'ssh-pi-isolation-'));
  const env = { PATH: process.env.PATH, REMOTE_PI_AGENT_BIN: process.env.REMOTE_PI_AGENT_BIN, REMOTE_PI_AGENT_SESSION_DIR: process.env.REMOTE_PI_AGENT_SESSION_DIR };
  try {
    const pi = path.join(root, 'fixture-pi');
    const ssh = path.join(root, 'ssh');
    const directory = path.join(root, "sessions ' $literal");
    await writeFile(pi, `#!${process.execPath}
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const args=process.argv.slice(2), dir=args[args.indexOf('--session-dir')+1];
fs.mkdirSync(dir,{recursive:true});
const file=path.join(dir,'current.jsonl');
if(!args.includes('--continue')) fs.writeFileSync(file,JSON.stringify({type:'session',id:crypto.randomUUID()})+'\\n');
const header=JSON.parse(fs.readFileSync(file,'utf8').split('\\n')[0]);
console.log(JSON.stringify(header));
fs.appendFileSync(file,JSON.stringify({type:'message',text:'new turn'})+'\\n');
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}]}}));
`);
    await writeFile(ssh, `#!${process.execPath}
const cp=require('child_process'),fs=require('fs');
const r=cp.spawnSync('bash',['-c',process.argv.at(-1)],{input:fs.readFileSync(0),encoding:'utf8'});
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);
`);
    await chmod(pi, 0o755); await chmod(ssh, 0o755);
    process.env.PATH = root + ':' + env.PATH;
    process.env.REMOTE_PI_AGENT_BIN = pi;
    process.env.REMOTE_PI_AGENT_SESSION_DIR = directory;
    const { executeRemoteSshTask } = await import('../src/lib/remote-harness/ssh-executor');
    const task = { id: 'same-task', name: 'fixture' };
    const samples: { sessionId: string; totalBytes: number; deltaBytes?: number }[] = [];
    const options = {
      timeout: 5000, harnessType: 'pi-agent',
      host: { id: 'fixture', label: 'fixture', host: 'fixture', port: 22, sshUser: 'fixture', authType: 'ssh_key', privateKey: 'fixture', workingDirectory: null, status: 'online', viaNetwork: 'test', supportedHarnesses: ['pi-agent'] },
      onSessionSize: (sessionId: string, size: { totalBytes: number; deltaBytes?: number }) => { samples.push({ sessionId, ...size }); },
    };
    const first = await executeRemoteSshTask(task, options);
    assert.equal(first.output, 'done');
    assert.equal(samples.at(-1)?.sessionId, first.sessionId);
    assert.equal(samples.at(-1)?.deltaBytes, samples.at(-1)?.totalBytes);
    const firstFile = path.join(first.sessionId!, 'current.jsonl');
    const original = await readFile(firstFile, 'utf8');
    const reset = await executeRemoteSshTask(task, options);
    assert.notEqual(reset.sessionId, first.sessionId, 'fresh sessions in the same task must have different directories');
    assert.equal(await readFile(firstFile, 'utf8'), original, 'reset leaves old records intact');
    const resetFile = path.join(reset.sessionId!, 'current.jsonl');
    const beforeResume = (await stat(resetFile)).size;
    assert.equal(samples.at(-1)?.totalBytes, beforeResume);
    assert.equal(samples.at(-1)?.deltaBytes, beforeResume);
    const resumed = await executeRemoteSshTask(task, { ...options, resumeSessionId: reset.sessionId, continuationMessage: 'next turn' });
    assert.equal(resumed.sessionId, reset.sessionId);
    assert.equal(samples.at(-1)?.totalBytes, (await stat(resetFile)).size);
    assert.equal(samples.at(-1)?.deltaBytes, (await stat(resetFile)).size - beforeResume);
    assert.equal(await readFile(firstFile, 'utf8'), original);
    // A pre-fix directory with accumulated histories keeps its continuation identity.
    const legacy = path.join(directory, 'acpx-same-task');
    await mkdir(legacy);
    await writeFile(path.join(legacy, 'old.jsonl'), JSON.stringify({ type: 'session', id: 'old' }) + '\n' + 'x'.repeat(20000));
    await writeFile(path.join(legacy, 'current.jsonl'), JSON.stringify({ type: 'session', id: 'legacy-current' }) + '\n');
    assert.equal((await executeRemoteSshTask(task, { ...options, resumeSessionId: legacy })).sessionId, legacy);
    assert.equal(samples.at(-1)?.totalBytes, (await stat(path.join(legacy, 'current.jsonl'))).size);
    const concurrent = await Promise.all([executeRemoteSshTask(task, options), executeRemoteSshTask(task, options)]);
    assert.notEqual(concurrent[0].sessionId, concurrent[1].sessionId, 'independent members must not share fresh directories');
    console.log('Remote Pi fresh/reset/resume/legacy/concurrent directory isolation passed');
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
