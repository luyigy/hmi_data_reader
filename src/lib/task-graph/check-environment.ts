import { graphInputsForTask } from './upstream-inputs';
import { withGraphTaskServices } from './graph-services';
import { graphDependencyPaths } from './dependency-paths';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { wrapWithBubblewrap } from '../harness/bubblewrap';
import { linkedWorktreeGitDirectories } from '../real-agents/git-worktree-paths';
import { graphGit } from './git-command';
import { runGraphCheck } from './check-runner';

/** Check code stays readonly; only ignored, task-local output directories can be written. */
export async function runSandboxedGraphCheck(argv: string[], cwd: string, extraEnv: Record<string, string> = {}, readOnlyWorkspaces: string[] = []) {
  if (!argv.length) throw new Error('Check command is empty');
  const extra = extraEnv.AP_GRAPH_SERVICE_TASK_ID ? await graphInputsForTask(extraEnv.AP_GRAPH_SERVICE_TASK_ID, true) : null;
  const root = realpathSync(cwd);
  const outputs: string[] = [];
  const protectedInputs: string[] = [];
  for (const name of ['scratch', '.pytest_cache', 'node_modules', 'frontend/dist', 'frontend/node_modules']) {
    try { await graphGit(root, 'check-ignore', '-q', '--no-index', '--', name + '/'); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 1) continue; throw error; }
    const target = path.join(root, name);
    if (existsSync(target) && realpathSync(target) !== target) continue; // Never turn a shared dependency symlink writable.
    const tracked = (await graphGit(root, 'ls-files', '-z', '--', name)).split('\0').filter(Boolean);
    const tops = Array.from(new Set(tracked.map((file) => file.slice(name.length + 1).split('/')[0])));
    if (tops.length > 200) throw new Error(`Check output contains too many tracked input directories: ${name}`);
    for (const top of tops) {
      const input = path.join(target, top);
      if (!top || !existsSync(input) || realpathSync(input) !== input) throw new Error(`Check input is missing or symlinked: ${input}`);
      protectedInputs.push(input); // Protect the entire first child, so a parent rename cannot relocate tracked inputs.
    }
    mkdirSync(target, { recursive: true }); outputs.push(target);
  }
  const metadata = linkedWorktreeGitDirectories(root);
  return withGraphTaskServices(extraEnv.AP_GRAPH_SERVICE_TASK_ID, 'platform-check', async services => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, ...(extra?.env.TASK_GRAPH_EXTRA_REPOS_JSON ? { TASK_GRAPH_EXTRA_REPOS_JSON: extra.env.TASK_GRAPH_EXTRA_REPOS_JSON } : {}), ...services.env, AP_TASK_SANDBOX: '1', AP_SANDBOX_MODEL_ACCESS: '0', HOME: '/tmp', TMPDIR: '/tmp', XDG_CACHE_HOME: '/tmp/cache' };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    const value = process.env[name] || process.env[name.toLowerCase()] || process.env['FEISHU_RUNTIME_CODEX_' + name];
    if (value) { env[name] = value; env[name.toLowerCase()] = value; }
  }
  const wrapped = wrapWithBubblewrap({ command: argv[0], commandArgs: argv.slice(1), cwd: root, workspaceRoot: root,
    sandboxMode: 'read-only', networkAccess: 'enabled', env, outputPaths: outputs,
    readOnlyPaths: [...protectedInputs, ...(extra?.paths || []), ...readOnlyWorkspaces, ...readOnlyWorkspaces.flatMap(linkedWorktreeGitDirectories), ...readOnlyWorkspaces.flatMap(graphDependencyPaths), ...graphDependencyPaths(root), ...metadata, ...(metadata.length ? [path.join(root, '.git')] : [])] });
  return runGraphCheck([wrapped.command, ...wrapped.args], root, env, undefined, argv, services.signal);
  });
}
