import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, symlinkSync, copyFileSync, chmodSync, rmSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Host-owned runtime state is separate from both the checkout and shared Git metadata. */
export function prepareGraphHarnessRuntime(taskId: string, harness: string) {
  if (!['codex', 'kimi-code'].includes(harness)) throw new Error(`${harness} 尚未通过任务级沙箱认证与权限验证；本轮支持 Codex / Kimi Code。`);
  const home = graphRuntimeHome(taskId);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const readonly: string[] = [];
  const writable: string[] = [];
  const source = harness === 'codex'
    ? process.env.CODEX_HOME || path.join(homedir(), '.codex')
    : process.env.KIMI_CODE_HOME || path.join(homedir(), '.kimi-code');
  const config = path.join(home, harness === 'codex' ? '.codex' : '.kimi-code');
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const shared = harness === 'codex' ? ['config.toml', 'skills', 'plugins', 'rules'] : ['config.toml', 'mcp.json', 'device_id', 'region', 'hooks'];
  for (const name of shared) {
    const sourcePath = path.join(source, name);
    if (!existsSync(sourcePath)) continue;
    const canonical = realpathSync(sourcePath);
    readonly.push(canonical);
    const target = path.join(config, name);
    if (!existsSync(target)) symlinkSync(canonical, target);
  }
  if (harness === 'codex' && existsSync(path.join(source, 'auth.json'))) {
    // The native CLI can atomically refresh its private auth file without a writable host HOME.
    try { copyFileSync(path.join(source, 'auth.json'), path.join(config, 'auth.json'), constants.COPYFILE_EXCL); chmodSync(path.join(config, 'auth.json'), 0o600); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  }
  if (harness === 'kimi-code') for (const name of ['credentials', 'oauth']) {
    const sourcePath = path.join(source, name);
    if (!existsSync(sourcePath)) continue;
    const canonical = realpathSync(sourcePath);
    writable.push(canonical); // Only these provider credential directories may refresh shared authentication.
    const target = path.join(config, name);
    if (!existsSync(target)) symlinkSync(canonical, target);
  }
  return { home, config, readonly, writable };
}

function graphRuntimeHome(taskId: string) {
  const root = process.env.TASK_GRAPH_RUNTIME_ROOT || path.join(homedir(), '.agent-platform', 'task-runtime');
  if (!path.isAbsolute(root)) throw new Error('Task runtime root must be absolute');
  return path.join(root, createHash('sha256').update(taskId).digest('hex').slice(0, 24));
}

/** Removes only the task's private state; rm does not traverse credential symlinks. */
export function clearGraphHarnessRuntime(taskId: string) {
  rmSync(graphRuntimeHome(taskId), { recursive: true, force: true });
}
