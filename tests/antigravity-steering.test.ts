import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { HarnessSteer } from '../src/lib/acpx/types';
import { antigravityHarnessAdapter } from '../src/lib/harness/adapters/antigravity';

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'agy-steering-'));
  const previousPath = process.env.PATH;
  await writeFile(path.join(dir, 'agy'), `#!/usr/bin/env node
const emit = x => console.log(JSON.stringify(x));
const prompt = process.argv[process.argv.indexOf('-p') + 1];
if (prompt.split('Antigravity completion contract:').length !== 2) process.exit(3);
emit({event:'init',conversation_id:'remembered-session'});
if (process.argv.includes('--conversation=remembered-session')) {
  if (!process.argv.some(x => x.includes('NEW_ONE') && x.includes('NEW_TWO'))) process.exit(2);
  emit({event:'result',result:{status:'SUCCESS',response:'NEW_DONE'}});
} else {
  setTimeout(() => emit({event:'step_update',step_update:{step_type:'tool',tool_name:'run_command',tool_info:{parameters:{CommandLine:'sleep 30'}}}}), 30);
  setTimeout(() => { emit({event:'result',result:{status:'SUCCESS',response:'OLD_DONE'}}); }, 30000);
}
`);
  await chmod(path.join(dir, 'agy'), 0o755);
  process.env.PATH = `${dir}:${previousPath}`;
  try {
    for (const stop of [false, true]) {
      let steer: HarnessSteer | undefined;
      let child: ChildProcess;
      let cleanup = 0, spawns = 0;
      const receipts: Promise<unknown>[] = [];
      const result = await antigravityHarnessAdapter.execute({
        task: { id:'test', name:'test' },
        context: {
          workingDirectory: dir, executionBackend: 'platform_local', timeout: 5000,
          onSpawn: value => { child = value; spawns++; },
          streamCallbacks: {
            onSteeringReady: value => { steer = value; return () => { cleanup++; }; },
            onStdoutChunk: chunk => {
              if (!chunk.includes('sleep 30')) return;
              receipts.push(steer!('one', 'NEW_ONE').then(value => assert.equal(value, 'accepted')));
              receipts.push(steer!('two', 'NEW_TWO').then(value => assert.equal(value, 'accepted')));
              if (stop) child.kill('SIGTERM');
            },
          },
        },
      });
      await Promise.all(receipts);
      assert.equal(cleanup, 1);
      assert.equal(spawns, stop ? 1 : 2, 'resume only after old process closes; stop cancels resume');
      assert.equal(result.success, !stop, result.error);
      if (!stop) assert.equal(result.output, 'NEW_DONE');
    }
    console.log('Antigravity interrupt/resume, combined instructions and explicit stop passed');
  } finally {
    process.env.PATH = previousPath;
    await rm(dir, {recursive:true, force:true});
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
