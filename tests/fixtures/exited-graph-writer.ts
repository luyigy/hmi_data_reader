import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseGraphWriter } from '../../src/lib/task-graph/writer-ownership';

/** Capture a real identity and wait for actual exit, including its original ancestry. */
export async function exitedGraphWriter() {
  const modulePath = require.resolve('../../src/lib/task-graph/writer-ownership');
  const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', '-e',
    `require(${JSON.stringify(modulePath)}).createGraphWriter().then(w=>console.log(JSON.stringify(w)))`], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk.toString(); });
  const [code] = await once(child, 'exit'); assert.equal(code, 0);
  const writer = parseGraphWriter(JSON.parse(output)); assert(writer);
  return writer;
}
