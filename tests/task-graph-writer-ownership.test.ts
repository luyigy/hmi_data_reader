import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { mock } from 'node:test';
import { createGraphWriter, observeGraphWriter } from '../src/lib/task-graph/writer-ownership';

async function main() {
  const writer = await createGraphWriter();
  assert.equal((await observeGraphWriter(writer)).kind, 'alive');
  assert.equal((await observeGraphWriter(writer, true)).kind, 'exited', 'A cleanup receipt is authoritative after the runner drains children');
  const scan = mock.method(fs, 'readdir', async () => { throw new Error('Historical process scan'); });
  try { assert.equal((await observeGraphWriter(writer, true)).kind, 'exited', 'Released history must not touch /proc'); }
  finally { scan.mock.restore(); }
  const inconsistent = { ...writer, supervisor: { ...writer.supervisor, pid: 2147483647 } };
  assert.equal((await observeGraphWriter(inconsistent)).kind, 'unknown', 'A changed supervisor cannot retain a different owner ancestry');
  const departed = { ...inconsistent, ancestry: undefined };
  assert.equal((await observeGraphWriter(departed)).kind, 'exited', 'A legacy owner without captured ancestry still distinguishes an absent supervisor');
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'], {
    env: { ...process.env, AP_GRAPH_WRITER_NONCE: writer.nonce }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await once(child.stdout, 'data');
    assert.equal((await observeGraphWriter(writer)).kind, 'alive', 'An unreleased owner prevents concurrent startup');
    const observation = await observeGraphWriter(departed);
    assert.equal(observation.kind, 'alive', 'A child survives its supervisor and must prevent takeover');
    if (observation.kind === 'alive') assert(child.pid && observation.pids.includes(child.pid));
    const originalRead = fs.readFile;
    const protectedRead = mock.method(fs, 'readFile', async (...args: Parameters<typeof originalRead>) => {
      if (String(args[0]) === `/proc/${child.pid}/environ`) throw Object.assign(new Error('Protected nonce process'), { code: 'EACCES' });
      return Reflect.apply(originalRead, fs, args);
    });
    try {
      assert.equal((await observeGraphWriter(departed)).kind, 'unknown', 'An unreadable real child cannot be excluded as an independent server branch');
    } finally { protectedRead.mock.restore(); }
  } finally {
    const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped;
  }
  assert.equal((await observeGraphWriter(departed)).kind, 'exited');
  assert.equal((await observeGraphWriter(null)).kind, 'unknown');
  assert.equal((await observeGraphWriter({ ...writer, hostname: 'unobservable-host' })).kind, 'unknown');
  console.log('Live supervisor and orphan child prevent takeover; confirmed exit and unknown ownership are distinguished');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
