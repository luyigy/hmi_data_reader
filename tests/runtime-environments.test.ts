import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveLocalRuntimeReadOnlyPaths } from '../src/lib/acpx/runtime-environments';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from '../src/lib/acpx/permissions';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';
import { applyWorkflowPermissionSnapshot, buildWorkflowPermissionSnapshot } from '../src/lib/workflow-execution-policy';
import { codexHarnessAdapter } from '../src/lib/harness/adapters/codex';
import { executeViaLocalHarness } from '../src/lib/acpx/runner-harness';
import { SHARED_ENTRIES } from '../src/lib/real-agents/codex-home';

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'ap-runtime-'));
  const workspace = path.join(root, 'project');
  const runtime = path.join(root, 'runtime');
  const configHome = path.join(root, 'config');
  const auth = path.join(root, 'auth');
  const file = path.join(root, 'runtimes.json');
  const permission = DEFAULT_ACPX_PERMISSION_CONFIG;
  for (const dir of [workspace, runtime, configHome, auth]) mkdirSync(dir);
  const configure = (paths: unknown) => writeFileSync(file, JSON.stringify({ [workspace]: paths }));
  try {
    assert.deepEqual(resolveLocalRuntimeReadOnlyPaths(workspace, permission, file), []);
    configure([runtime, runtime]);
    const readOnlyPaths = resolveLocalRuntimeReadOnlyPaths(workspace, permission, file);
    assert.deepEqual(readOnlyPaths, [runtime]);
    assert.deepEqual(resolveLocalRuntimeReadOnlyPaths(root, permission, file), []);
    assert.deepEqual(resolveLocalRuntimeReadOnlyPaths(workspace, { ...permission, profile: 'full_access' }, file), []);
    const snapshot = buildWorkflowPermissionSnapshot({
      policy: { preset: 'workspace', extraReadOnlyPaths: [auth] }, projectPath: workspace, source: 'test',
    });
    assert.deepEqual(resolveLocalRuntimeReadOnlyPaths(workspace,
      applyWorkflowPermissionSnapshot(permission, snapshot), file), [auth]);
    const fullSnapshot = buildWorkflowPermissionSnapshot({ policy: { preset: 'full_access' }, projectPath: workspace, source: 'test' });
    assert.deepEqual(resolveLocalRuntimeReadOnlyPaths(workspace,
      applyWorkflowPermissionSnapshot(permission, fullSnapshot), file), []);
    for (const invalid of [['/'], ['relative'], ['/tmp/../etc'], 'bad', [42]]) {
      configure(invalid);
      assert.throws(() => resolveLocalRuntimeReadOnlyPaths(workspace, permission, file));
    }
    configure([path.join(root, 'missing')]);
    assert.throws(() => resolveLocalRuntimeReadOnlyPaths(workspace, permission, file), /ENOENT/);
    const alias = path.join(root, 'alias');
    symlinkSync(runtime, alias);
    configure([alias]);
    assert.throws(() => resolveLocalRuntimeReadOnlyPaths(workspace, permission, file), /canonical/);
    writeFileSync(file, '{bad');
    assert.throws(() => resolveLocalRuntimeReadOnlyPaths(workspace, permission, file));

    // Only explicitly authorized directories become visible through symlinks.
    writeFileSync(path.join(runtime, 'marker'), 'runtime');
    writeFileSync(path.join(auth, 'token'), 'auth');
    symlinkSync(path.join(auth, 'token'), path.join(configHome, 'token'));
    symlinkSync(path.join(runtime, 'marker'), path.join(workspace, 'runtime-marker'));
    const wrapped = wrapWithBubblewrap({
      command: '/usr/bin/sh', commandArgs: ['-c',
        `test -r runtime-marker && test -r '${configHome}/token' && ! touch '${runtime}/write-probe' && test ! -e /etc/passwd`],
      cwd: workspace, workspaceRoot: workspace, env: process.env, configPaths: [configHome], readOnlyPaths: [...readOnlyPaths, auth],
    });
    const result = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    // Exercise actual adapter forwarding for both fresh and resumed sessions.
    type CodexAgent = typeof import('../src/lib/real-agents/codex-agent');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- mutate CommonJS exports to avoid launching an agent
    const agent = require('../src/lib/real-agents/codex-agent') as { -readonly [K in keyof CodexAgent]: CodexAgent[K] };
    const originalExecute = agent.executeCodexTask;
    const originalResume = agent.resumeCodexSession;
    const seen: unknown[] = [];
    const sandboxModes: unknown[] = [];
    agent.executeCodexTask = async (_task, options) => {
      seen.push(options?.readOnlyPaths);
      sandboxModes.push(options?.sandboxMode);
      return { success: true, output: 'ok', executionTime: 0, filesModified: [] };
    };
    agent.resumeCodexSession = async (options) => {
      seen.push(options.readOnlyPaths);
      sandboxModes.push(options.sandboxMode);
      return { output: 'ok', threadId: 'test' };
    };
    try {
      const task = { id: 'test', name: 'test' };
      const context = { workingDirectory: workspace, workspaceRoot: workspace,
        extraReadOnlyPaths: readOnlyPaths, permissionConfig: permission, timeout: 1000, executionBackend: 'platform_local' as const };
      assert.equal((await codexHarnessAdapter.execute({ task, context })).success, true);
      assert.equal((await codexHarnessAdapter.resume!({ task, context, sessionId: 'test', continuationMessage: 'test' })).success, true);
      const sharedHome = process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex');
      const expectedPaths = [...SHARED_ENTRIES.map((entry) => path.join(sharedHome, entry)), runtime];
      assert.deepEqual(seen, [expectedPaths, expectedPaths]);
      assert.deepEqual(sandboxModes, ['danger-full-access', 'danger-full-access'], 'Bubblewrap must be the sole write boundary for workspace-write Codex sessions');
      await codexHarnessAdapter.execute({ task, context: { ...context, workspaceRoot: undefined } });
      assert.equal(sandboxModes.at(-1), 'workspace-write', 'Keep the native sandbox when no external boundary exists');
      await codexHarnessAdapter.execute({ task, context: { ...context, permissionConfig: { ...permission, sandboxMode: 'read-only' } } });
      assert.equal(sandboxModes.at(-1), 'read-only', 'Read-only reviewers must remain read-only');
      assert.ok(!expectedPaths.includes(sharedHome), 'do not expose unrelated Codex session history');
    } finally {
      agent.executeCodexTask = originalExecute;
      agent.resumeCodexSession = originalResume;
    }
    // Task A uses Kimi: cover the runner -> adapter chain, including continuation.
    type RuntimeModule = typeof import('../src/lib/acpx/runtime-environments');
    type KimiModule = typeof import('../src/lib/real-agents/kimi-code-agent');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- inject temporary host configuration
    const resolver = require('../src/lib/acpx/runtime-environments') as { -readonly [K in keyof RuntimeModule]: RuntimeModule[K] };
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- avoid launching an agent
    const kimi = require('../src/lib/real-agents/kimi-code-agent') as { -readonly [K in keyof KimiModule]: KimiModule[K] };
    const originalResolver = resolver.resolveLocalRuntimeReadOnlyPaths;
    const originalKimi = kimi.executeKimiCodeTask;
    const kimiSessions: Array<string | undefined> = [];
    const secondWorkspace = path.join(root, 'second-workspace'); mkdirSync(secondWorkspace);
    configure([runtime]);
    resolver.resolveLocalRuntimeReadOnlyPaths = (cwd, config) => originalResolver(cwd, config, file);
    kimi.executeKimiCodeTask = async (_task, options) => {
      assert.deepEqual(options?.extraReadOnlyPaths, [runtime, secondWorkspace]);
      assert.equal(options?.permissionProfile, 'dev_local');
      assert.equal(options?.workspaceRoot, workspace);
      kimiSessions.push(options?.sessionId);
      return { success: true, output: 'ok', executionTime: 0 };
    };
    try {
      const participant = { gatewayId: 'local', executionBackend: 'platform_local' as const, harnessType: 'kimi-code', role: 'custom' };
      const request = { taskId: 'test', taskName: 'test', orchestrationMode: 'single' as const,
        workingDirectory: workspace, participants: [participant], permissionConfig: permission, extraReadOnlyPaths: [secondWorkspace] };
      const room = { transcript: '', latestUserMessage: null };
      await executeViaLocalHarness(request, 'run', 'member', participant, {}, [], room);
      await executeViaLocalHarness(request, 'run', 'member',
        { ...participant, resumeSessionId: 'existing-session', continuationMessage: 'continue' }, {}, [], room);
      assert.deepEqual(kimiSessions, [undefined, 'existing-session']);
      await assert.rejects(executeViaLocalHarness({ ...request, permissionConfig: { ...permission, sandboxMode: 'read-only' } },
        'run', 'member', { ...participant, harnessType: 'pi-agent' }, {}, [], room), /尚不支持强制只读/);
    } finally {
      resolver.resolveLocalRuntimeReadOnlyPaths = originalResolver;
      kimi.executeKimiCodeTask = originalKimi;
    }
    console.log('runtime-environments: validation, isolation, read-only mounts, execute/resume passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
