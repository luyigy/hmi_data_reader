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

export function wrapWithBubblewrap(args: {
  command: string;
  commandArgs: string[];
  cwd: string;
  workspaceRoot?: string;
  networkAccess?: 'restricted' | 'enabled';
  env: NodeJS.ProcessEnv;
  configPaths?: string[];
}) {
  if (!args.workspaceRoot) return { command: args.command, args: args.commandArgs };
  if (!existsSync('/usr/bin/bwrap')) throw new Error('受限 Feishu 用户需要 /usr/bin/bwrap，但当前主机未安装。');

  const executable = executablePath(args.command, args.env);
  const executableMount = executable.endsWith('.js') ? path.dirname(path.dirname(executable)) : executable;
  const systemCertificates = '/etc/ssl/certs';
  const configPaths = (args.configPaths || []).filter(existsSync);
  const mounts = [executableMount, ...configPaths, ...configPaths.flatMap(symlinkTargets)]
    .filter((source, index, all) => !source.startsWith('/usr/') && all.indexOf(source) === index);
  const bwrapArgs = [
    '--die-with-parent', '--new-session', '--unshare-all',
    ...(args.networkAccess === 'enabled' ? ['--share-net'] : []),
    '--tmpfs', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/usr', '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    ...(existsSync(systemCertificates) ? [...parentDirs(systemCertificates), '--ro-bind', systemCertificates, systemCertificates] : []),
    ...parentDirs(args.workspaceRoot), '--bind', args.workspaceRoot, args.workspaceRoot,
    ...mounts.flatMap((source) => [...parentDirs(source), '--bind', source, source]),
    '--chdir', args.cwd,
    executable,
    ...args.commandArgs,
  ];
  return { command: '/usr/bin/bwrap', args: bwrapArgs };
}
