import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = mkdtempSync(path.join(tmpdir(), 'workflow-reload-test-'));
const services = ['agent-platform-task-graph.service', 'agent-platform-feishu.service', 'agent-platform-task-graph-feishu.service'];
try {
  const loader = path.join(directory, 'loader.mjs');
  writeFileSync(loader, `
    export async function resolve(specifier, context, nextResolve) {
      if (specifier !== '@prisma/client') return nextResolve(specifier, context);
      const source = 'export class PrismaClient { taskRun = { count: async () => 0 }; async $disconnect() { console.log("TEST_DB_DISCONNECTED"); } }';
      return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
    }
  `);
  const systemctl = path.join(directory, 'systemctl');
  writeFileSync(systemctl, `#!${process.execPath}
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + '\\n');
    const restarted = fs.existsSync(process.env.TEST_RESTARTED);
    if (args[1] === 'restart') {
      if (process.env.TEST_MODE === 'restart-failed') process.exit(1);
      fs.writeFileSync(process.env.TEST_RESTARTED, 'yes');
    } else if (args[1] === 'is-active') {
      if (process.env.TEST_MODE === 'inactive' && args[2] === 'agent-platform-task-graph-feishu.service') process.exit(1);
      console.log('active');
    } else if (args[1] === 'show') {
      const oldPid = 100 + ${JSON.stringify(services)}.indexOf(args[2]);
      const relay = args[2] === 'agent-platform-task-graph-feishu.service';
      console.log(!restarted || (relay && process.env.TEST_MODE === 'unchanged') ? oldPid : relay && process.env.TEST_MODE === 'zero' ? 0 : oldPid + 1000);
    } else process.exit(2);
  `);
  chmodSync(systemctl, 0o755);

  for (const mode of ['reloaded', 'unchanged', 'zero', 'restart-failed', 'inactive']) {
    const callsFile = path.join(directory, `${mode}.calls`);
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, path.join(root, 'scripts/reload-task-graph-workflow-when-idle.mjs')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, TEST_MODE: mode, TEST_CALLS: callsFile, TEST_RESTARTED: path.join(directory, `${mode}.restarted`) },
    });
    assert.ifError(result.error);
    const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls.find((args) => args[1] === 'restart'), ['--user', 'restart', ...services], 'Restart must include the dedicated task graph Feishu relay');
    assert.match(result.stdout, /TEST_DB_DISCONNECTED/, 'Always disconnect the database');
    if (mode === 'reloaded') {
      assert.equal(result.status, 0, result.stderr);
      for (const service of services) {
        assert(calls.some((args) => JSON.stringify(args) === JSON.stringify(['--user', 'is-active', service])));
        assert.equal(calls.filter((args) => args[1] === 'show' && args[2] === service).length, 2);
      }
      assert.match(result.stdout, /Workflow runtimes reloaded/);
    } else {
      assert.notEqual(result.status, 0, `Must reject ${mode}`);
      assert.doesNotMatch(result.stdout, /Workflow runtimes reloaded/);
      if (mode === 'unchanged' || mode === 'zero') assert.match(result.stderr, /Runtime reload failed.*MainPID/);
    }
    console.log(`PASS ${mode}`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
