import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexHarnessAdapter } from '../src/lib/harness/adapters/codex';
import type { HarnessExecutionContext } from '../src/lib/harness/types';
import { prepareGraphHarnessRuntime } from '../src/lib/task-graph/harness-runtime';

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-shared-auth-adapter-'));
  const host = path.join(root, 'host');
  const workspace = path.join(root, 'workspace');
  const bin = path.join(root, 'bin');
  for (const directory of [host, workspace, bin, path.join(host, 'skills')]) mkdirSync(directory);
  const previous = { CODEX_HOME: process.env.CODEX_HOME, TASK_GRAPH_RUNTIME_ROOT: process.env.TASK_GRAPH_RUNTIME_ROOT, PATH: process.env.PATH };
  const auth = path.join(host, 'auth.json');
  writeFileSync(auth, JSON.stringify({ fixtureRefreshes: 0 }));
  writeFileSync(path.join(host, 'config.toml'), '# fixture');
  writeFileSync(path.join(host, 'skills', 'marker'), 'protected');
  writeFileSync(path.join(host, 'unrelated'), 'not mounted');
  const alias = path.join(root, 'auth-alias');
  symlinkSync(auth, alias);
  writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const home = process.env.CODEX_HOME;
const transport = process.argv.includes('app-server') ? 'app-server' : 'exec';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
function probe() {
  const auth = path.join(home, 'auth.json');
  const state = JSON.parse(fs.readFileSync(auth, 'utf8'));
  state.fixtureRefreshes += 1;
  fs.writeFileSync(auth, JSON.stringify(state));
  for (const file of ['config.toml', 'skills/marker']) {
    assert.throws(() => fs.openSync(path.join(home, file), 'r+'), error => ['EROFS', 'EACCES'].includes(error.code));
  }
  const mode = fs.readFileSync('mode.txt', 'utf8');
  if (mode === 'read-only') {
    assert.throws(() => fs.writeFileSync('forbidden', 'x'), error => ['EROFS', 'EACCES'].includes(error.code));
  } else {
    fs.writeFileSync('allowed', 'x');
    fs.unlinkSync('allowed');
  }
  assert.equal(fs.existsSync(path.join(path.dirname(fs.realpathSync(auth)), 'unrelated')), false);
  fs.appendFileSync(path.join(home, 'transports.log'), transport + '\\n');
  return 'shared auth writable; other config protected; workspace ' + mode;
}
if (transport === 'exec') {
  send({type:'thread.started', thread_id:'fixture-thread'});
  send({type:'item.completed', item:{type:'agent_message', text:probe()}});
  send({type:'turn.completed'});
} else {
  require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      send({id:message.id, result:{thread:{id:'fixture-thread'}}});
    } else if (message.method === 'turn/start') {
      const text = probe();
      send({id:message.id, result:{turn:{id:'fixture-turn'}}});
      send({method:'turn/started', params:{threadId:'fixture-thread', turn:{id:'fixture-turn'}}});
      send({method:'item/agentMessage/delta', params:{delta:text}});
      send({method:'turn/completed', params:{threadId:'fixture-thread', turn:{id:'fixture-turn', status:'completed'}}});
    } else send({id:message.id, result:{}});
  });
}
`, { mode: 0o700 });
  process.env.CODEX_HOME = host;
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime');
  process.env.PATH = `${bin}${path.delimiter}${previous.PATH || ''}`;
  try {
    const runtime = prepareGraphHarnessRuntime('task-graph-auth-fixture', 'codex');
    const task = { id: 'auth-fixture', name: 'Shared authentication permission probe' };
    let refreshes = 0;
    for (const transport of ['exec', 'app-server']) {
      for (const sandboxMode of ['read-only', 'workspace-write'] as const) {
        writeFileSync(path.join(workspace, 'mode.txt'), sandboxMode);
        for (const explicitPaths of [true, false]) {
          const context: HarnessExecutionContext = {
            executionBackend: 'platform_local', executionId: `auth-${refreshes}`,
            workingDirectory: workspace, workspaceRoot: workspace,
            codexHome: runtime.config, runtimeHome: runtime.home,
            extraWritableRoots: runtime.writable,
            extraReadOnlyPaths: explicitPaths ? [...runtime.readonly, auth, alias, path.join(runtime.config, 'auth.json')] : [],
            networkAccess: 'restricted', timeout: 5000,
            permissionConfig: { profile: 'custom', sandboxMode, approvalPolicy: 'never', networkAccess: 'restricted', writableRoots: [workspace] },
            ...(transport === 'app-server' ? { streamCallbacks: { onSteeringReady: () => () => {} } } : {}),
          };
          for (const resume of [false, true]) {
            const label = `${transport} ${sandboxMode} explicit=${explicitPaths} resume=${resume}`;
            const result = await (resume
              ? codexHarnessAdapter.resume!({ task, context, sessionId: 'fixture-thread', continuationMessage: 'probe again' })
              : codexHarnessAdapter.execute({ task, context }));
            assert.equal(result.success, true, `${label}: ${result.error}`);
            assert.match(result.output || '', /shared auth writable; other config protected/);
            assert.equal(JSON.parse(readFileSync(auth, 'utf8')).fixtureRefreshes, ++refreshes, label);
            assert.equal(readFileSync(path.join(runtime.config, 'transports.log'), 'utf8').trim().split('\n').at(-1), transport, 'No transport fallback can count as app-server coverage');
          }
        }
      }
    }
    console.log(`Shared auth: ${refreshes} real adapter launches/resumes passed through both transports and workspace modes, with explicit aliases and default mounts.`);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
