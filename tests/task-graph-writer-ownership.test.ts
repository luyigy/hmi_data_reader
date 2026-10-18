import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createGraphWriter, observeGraphWriter } from '../src/lib/task-graph/writer-ownership';

async function main() {
  const writer = await createGraphWriter();
  assert.equal((await observeGraphWriter(writer)).kind, 'alive');
  assert.equal((await observeGraphWriter(writer, true)).kind, 'exited', 'Cleanup receipt may release the daemon supervisor, but never bypass child scanning');
  const departed = { ...writer, supervisor: { ...writer.supervisor, pid: 2147483647 } };
  assert.equal((await observeGraphWriter(departed)).kind, 'exited', 'An absent supervisor is distinguished from an unknown owner');
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'], {
    env: { ...process.env, AP_GRAPH_WRITER_NONCE: writer.nonce }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await once(child.stdout, 'data');
    assert.equal((await observeGraphWriter(writer, true)).kind, 'alive', 'Released supervisor still cannot hide a live nonce child');
    const observation = await observeGraphWriter(departed);
    assert.equal(observation.kind, 'alive', 'A child survives its supervisor and must prevent takeover');
    if (observation.kind === 'alive') assert(child.pid && observation.pids.includes(child.pid));
  } finally {
    const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped;
  }
  assert.equal((await observeGraphWriter(departed)).kind, 'exited');
  assert.equal((await observeGraphWriter(null)).kind, 'unknown');
  assert.equal((await observeGraphWriter({ ...writer, hostname: 'unobservable-host' })).kind, 'unknown');
  console.log('Live supervisor and orphan child prevent takeover; confirmed exit and unknown ownership are distinguished');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
