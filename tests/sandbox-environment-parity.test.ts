import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { transpileModule, ModuleKind } from 'typescript';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';
import { prepareSandboxEnvironment } from '../src/lib/sandbox-manager/environment';
import { renderBubblewrap } from '../src/lib/sandbox-manager/bubblewrap';

const baseline = '1054a5e';
const source = execFileSync('git', ['show', `${baseline}:src/lib/harness/bubblewrap.ts`], { encoding: 'utf8' });
const original = { exports: { wrapWithBubblewrap } };
new Function('require', 'module', 'exports', transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, esModuleInterop: true } }).outputText)(
  createRequire(path.join(process.cwd(), 'src/lib/harness/bubblewrap.ts')), original, original.exports,
);
const legacy = original.exports.wrapWithBubblewrap;
const baselineOnly = process.env.S01_TEST_BASELINE === '1';
const candidate = baselineOnly ? legacy : wrapWithBubblewrap;
const root = mkdtempSync(path.join(tmpdir(), 'sandbox-parity-'));
try {
  const workspace = path.join(root, 'workspace');
  const shared = path.join(root, 'shared');
  const outside = path.join(root, 'outside');
  const output = path.join(root, 'output');
  for (const directory of [workspace, shared, outside, output]) mkdirSync(directory);
  writeFileSync(path.join(outside, 'secret'), 'hidden');
  symlinkSync(outside, path.join(shared, 'linked'));
  mkdirSync(path.join(workspace, '.git'));
  execFileSync('python3', ['-m', 'venv', '--without-pip', path.join(workspace, '.venv')]);
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: '/usr/bin:/bin', TEST_FIXED_SECRET: 'fixture-only' };
  const base = { command: '/usr/bin/sh', commandArgs: ['-c', 'true'], cwd: workspace, workspaceRoot: workspace, env };
  const cases: Parameters<typeof wrapWithBubblewrap>[0][] = [
    base,
    { ...base, workspaceRoot: undefined, command: 'missing-tool', cwd: '/missing' },
    { ...base, networkAccess: 'enabled' },
    { ...base, sandboxMode: 'read-only', writableRoots: [outside], configPaths: [shared] },
    { ...base, writableRoots: [outside, outside, workspace], outputPaths: [path.join(workspace, '.git')] },
    { ...base, readOnlyPaths: [shared] },
    { ...base, readOnlyPaths: [shared], strictReadOnlyRoots: true },
    { ...base, configPaths: [shared] },
    { ...base, readOnlyPaths: [], configPaths: [shared] },
    { ...base, readOnlyPaths: [shared], env: { ...base.env, AP_PROJECT_CAPABILITY_SOCKET: '/fixture.sock' } },
    { ...base, readOnlyPaths: [shared], env: { ...base.env, AP_PROJECT_CAPABILITIES_JSON: '{}' } },
    { ...base, env: { ...base.env, AP_TASK_SANDBOX: '1' }, command: 'python' },
    { ...base, env: { ...base.env, AP_TASK_SANDBOX: '1' }, command: path.join(workspace, '.venv/bin/python') },
    { ...base, outputPaths: [outside] },
    { ...base, outputPaths: [workspace] },
    { ...base, cwd: outside },
    { ...base, command: 'missing-tool' },
    { ...base, env: { ...base.env, AP_GRAPH_OUTPUT_BINDINGS_JSON: '[]' } },
    { ...base, env: { ...base.env, AP_GRAPH_OUTPUT_DIR: output, AP_GRAPH_OUTPUT_BINDINGS_JSON: '[{"source":"/escape","target":"/escape","readOnly":false}]' } },
    { ...base, env: { ...base.env, AP_TASK_SANDBOX: '1', AP_PROJECT_PYTHON_ENVIRONMENTS_JSON: 'invalid' } },
  ];
  const capture = (run: () => ReturnType<typeof wrapWithBubblewrap>) => {
    try { return { value: run() }; }
    catch (error) { if (!(error instanceof Error)) throw error; return { error: error.message, name: error.name }; }
  };
  cases.forEach((input, index) => {
    assert.deepEqual(capture(() => candidate(input)), capture(() => legacy(input)), `baseline argv/error parity case ${index}`);
    const workspaceRoot = input.workspaceRoot;
    if (workspaceRoot && !baselineOnly) {
      assert.deepEqual(capture(() => renderBubblewrap(prepareSandboxEnvironment({ ...input, workspaceRoot }))), capture(() => legacy(input)), `shared renderer parity case ${index}`);
    }
  });
  const probe = 'test -w "$PWD" && test -r /etc/hosts && test ! -e /etc/passwd && readlink /proc/self/ns/net';
  const hostNetwork = readlinkSync('/proc/self/ns/net');
  for (const networkAccess of ['restricted', 'enabled'] satisfies Array<'restricted' | 'enabled'>) {
    const wrapped = candidate({ ...base, networkAccess, commandArgs: ['-c', probe] });
    const actual = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8', env: base.env });
    assert.equal(actual.status, 0, actual.stderr);
    assert.equal(actual.stdout.trim() === hostNetwork, networkAccess === 'enabled');
  }
  const python = candidate({ ...base, command: 'python', commandArgs: ['-c', 'import sys; print(sys.prefix)'], env: { ...base.env, AP_TASK_SANDBOX: '1' } });
  assert.equal(execFileSync(python.command, python.args, { encoding: 'utf8', env: base.env }).trim(), path.join(workspace, '.venv'));
  console.log(`PASS ${baselineOnly ? `baseline ${baseline}` : `candidate vs ${baseline}`} compiler parity: ${cases.length} fixtures; real Bubblewrap restricted/enabled namespaces and Python venv`);
} finally { rmSync(root, { recursive: true, force: true }); }
