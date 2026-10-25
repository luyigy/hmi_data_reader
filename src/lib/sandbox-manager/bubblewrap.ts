import { writableProbeCommand } from './writable-probe';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { PreparedSandboxEnvironment } from './environment';

export function assertBubblewrapAvailable() {
  if (!existsSync('/usr/bin/bwrap')) throw new Error('受限 Feishu 用户需要 /usr/bin/bwrap，但当前主机未安装。');
}

/** This is the only compiler of Bubblewrap flags for both legacy and managed launches. */
export function renderBubblewrap(plan: PreparedSandboxEnvironment) {
  const declaredParentDirs = new Set<string>();
  const parentDirs = (target: string) => {
    const dirs: string[] = [];
    for (let current = path.dirname(target); current !== '/'; current = path.dirname(current)) dirs.unshift(current);
    return dirs.filter((directory) => !['/usr', '/tmp', '/proc', '/dev'].includes(directory) && !declaredParentDirs.has(directory)).flatMap((directory) => {
      declaredParentDirs.add(directory);
      return ['--dir', directory];
    });
  };
  const systemCertificates = '/etc/ssl/certs';
  const systemHosts = '/etc/hosts';
  const systemResolvConf = '/etc/resolv.conf';
  const systemTopologyPaths = ['/sys/devices/system/cpu', '/sys/devices/system/node'].filter(existsSync);
  const readOnlyMounts = [
    ...plan.automaticReadOnlyMounts,
    ...systemTopologyPaths,
    ...plan.explicitReadOnlyMounts,
  ].filter((source, index, all) => !source.startsWith('/usr/') && all.indexOf(source) === index);
  const bwrapArgs = [
    '--die-with-parent', '--new-session', '--unshare-all',
    ...plan.environmentRemovals.flatMap((key) => ['--unsetenv', key]),
    ...Object.entries(plan.environmentOverrides).flatMap(([key, value]) => ['--setenv', key, value]),
    ...(plan.networkAccess === 'enabled' ? ['--share-net'] : []),
    '--tmpfs', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/usr', '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    ...(existsSync(systemCertificates) ? [...parentDirs(systemCertificates), '--ro-bind', systemCertificates, systemCertificates] : []),
    ...(existsSync(systemHosts) ? [...parentDirs(systemHosts), '--ro-bind', realpathSync(systemHosts), systemHosts] : []),
    ...(existsSync(systemResolvConf) ? [...parentDirs(systemResolvConf), '--ro-bind', realpathSync(systemResolvConf), systemResolvConf] : []),
    ...parentDirs(plan.workspaceRoot), plan.sandboxMode === 'read-only' ? '--ro-bind' : '--bind', plan.workspaceRoot, plan.workspaceRoot,
    ...plan.writableMounts.flatMap((source) => [...parentDirs(source), '--bind', source, source]),
    ...readOnlyMounts.flatMap((source) => [...parentDirs(source), '--ro-bind', source, source]),
    ...plan.runtimeOutputs.flatMap(({ source, target, readOnly }) => [...parentDirs(target), readOnly ? '--ro-bind' : '--bind', source, target]),
    '--chdir', plan.cwd,
    ...writableProbeCommand(plan.requiredWritableRoots),
    plan.invocation,
    ...plan.commandArgs,
  ];
  return { command: '/usr/bin/bwrap', args: bwrapArgs };
}
