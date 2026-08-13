import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

const executablePath = (command: string, env: NodeJS.ProcessEnv) => {
  if (command.includes('/')) return realpathSync(command);
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(directory, command);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`找不到本地 harness：${command}`);
};

const parentDirs = (target: string) => {
  const dirs: string[] = [];
  for (let current = path.dirname(target); current !== '/'; current = path.dirname(current)) dirs.unshift(current);
  return dirs.filter((directory) => !['/usr', '/tmp', '/proc', '/dev'].includes(directory)).flatMap((directory) => ['--dir', directory]);
};

const symlinkTargets = (directory: string) => {
  if (!lstatSync(directory).isDirectory()) return [];
  return readdirSync(directory)
    .map((entry) => path.join(directory, entry))
    .filter((entry) => lstatSync(entry).isSymbolicLink() && existsSync(entry))
    .map((entry) => realpathSync(entry));
};

const isWithin = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export function wrapWithBubblewrap(args: {
  command: string;
  commandArgs: string[];
  cwd: string;
  workspaceRoot?: string;
  writableRoots?: string[];
  networkAccess?: 'restricted' | 'enabled';
  env: NodeJS.ProcessEnv;
  configPaths?: string[];
  readOnlyPaths?: string[];
}) {
  if (!args.workspaceRoot) return { command: args.command, args: args.commandArgs };
  if (!existsSync('/usr/bin/bwrap')) throw new Error('受限 Feishu 用户需要 /usr/bin/bwrap，但当前主机未安装。');

  const workspaceRoot = realpathSync(args.workspaceRoot);
  const cwd = realpathSync(args.cwd);
  if (!isWithin(workspaceRoot, cwd)) throw new Error('Bubblewrap cwd is outside the authorized workspace');
  const executable = executablePath(args.command, args.env);
  const executableMount = executable.endsWith('.js') ? path.dirname(path.dirname(executable)) : executable;
  const systemCertificates = '/etc/ssl/certs';
  const systemHosts = '/etc/hosts';
  const systemResolvConf = '/etc/resolv.conf';
  const systemTopologyPaths = ['/sys/devices/system/cpu', '/sys/devices/system/node'].filter(existsSync);
  const configPaths = (args.configPaths || []).filter(existsSync);
  const explicitReadOnlyPaths = args.readOnlyPaths?.filter(existsSync).flatMap((source) => {
    const resolved = realpathSync(source);
    return [resolved, ...symlinkTargets(resolved)];
  });
  const writableMounts = configPaths.map((source) => realpathSync(source))
    .filter((source) => !isWithin(workspaceRoot, source));
  const extraWritableMounts = (args.writableRoots || [])
    .filter(existsSync)
    .map((source) => realpathSync(source))
    .filter((source) => !isWithin(workspaceRoot, source));
  const allWritableMounts = [...writableMounts, ...extraWritableMounts]
    .filter((source, index, all) => all.indexOf(source) === index);
  const readOnlyMounts = [
    executableMount,
    ...systemTopologyPaths,
    ...(explicitReadOnlyPaths ?? configPaths.flatMap(symlinkTargets)),
  ]
    .filter((source, index, all) => !source.startsWith('/usr/') && all.indexOf(source) === index);
  const bwrapArgs = [
    '--die-with-parent', '--new-session', '--unshare-all',
    ...(args.networkAccess === 'enabled' ? ['--share-net'] : []),
    '--tmpfs', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/usr', '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    ...(existsSync(systemCertificates) ? [...parentDirs(systemCertificates), '--ro-bind', systemCertificates, systemCertificates] : []),
    ...(existsSync(systemHosts) ? [...parentDirs(systemHosts), '--ro-bind', realpathSync(systemHosts), systemHosts] : []),
    ...(existsSync(systemResolvConf) ? [...parentDirs(systemResolvConf), '--ro-bind', realpathSync(systemResolvConf), systemResolvConf] : []),
    ...parentDirs(workspaceRoot), '--bind', workspaceRoot, workspaceRoot,
    ...allWritableMounts.flatMap((source) => [...parentDirs(source), '--bind', source, source]),
    ...readOnlyMounts.flatMap((source) => [...parentDirs(source), '--ro-bind', source, source]),
    '--chdir', cwd,
    executable,
    ...args.commandArgs,
  ];
  return { command: '/usr/bin/bwrap', args: bwrapArgs };
}
