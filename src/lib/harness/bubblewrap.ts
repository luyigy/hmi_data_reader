import { pinnedSandboxPython } from '../project-capabilities/python-runtime';
import { sandboxOutputBindings } from './output-bindings';
import { sandboxProjectEnvironment } from './project-environment';
import { sandboxEnvironmentRemovals } from './sandbox-env';
import { localToolchainPaths } from './toolchain-paths';
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
  outputPaths?: string[];
  networkAccess?: 'restricted' | 'enabled';
  sandboxMode?: string;
  env: NodeJS.ProcessEnv;
  configPaths?: string[];
  readOnlyPaths?: string[];
  strictReadOnlyRoots?: boolean;
}) {
  if (!args.workspaceRoot) return { command: args.command, args: args.commandArgs };
  if (!existsSync('/usr/bin/bwrap')) throw new Error('受限 Feishu 用户需要 /usr/bin/bwrap，但当前主机未安装。');

  const workspaceRoot = realpathSync(args.workspaceRoot);
  const cwd = realpathSync(args.cwd);
  if (!isWithin(workspaceRoot, cwd)) throw new Error('Bubblewrap cwd is outside the authorized workspace');
  let project: ReturnType<typeof sandboxProjectEnvironment>;
  if (args.env.AP_TASK_SANDBOX === '1') {
    project = args.env.AP_PROJECT_PYTHON_ENVIRONMENTS_JSON !== undefined
      ? pinnedSandboxPython(args.env.AP_PROJECT_PYTHON_ENVIRONMENTS_JSON, args.readOnlyPaths || [], args.env.AP_PROJECT_REPOSITORY)
      : sandboxProjectEnvironment(workspaceRoot, args.readOnlyPaths, args.env.AP_PROJECT_REPOSITORY);
  }
  const launchEnv = { ...args.env, ...project?.env };
  const executable = executablePath(args.command, launchEnv);
  // Python determines its venv from the invoked symlink, not its resolved base binary.
  const projectCommand = project && path.join(project.directory, 'bin', args.command);
  const invocation = project && path.isAbsolute(args.command) && isWithin(path.join(project.directory, 'bin'), args.command)
    ? args.command : projectCommand && !args.command.includes('/') && existsSync(projectCommand) ? projectCommand : executable;
  const packagedCodex = path.basename(executable) === 'codex'
    && existsSync(path.join(path.dirname(executable), 'codex-code-mode-host'));
  const executableMount = executable.endsWith('.js') ? path.dirname(path.dirname(executable))
    : packagedCodex ? path.dirname(executable) : executable;
  const systemCertificates = '/etc/ssl/certs';
  const systemHosts = '/etc/hosts';
  const systemResolvConf = '/etc/resolv.conf';
  const systemTopologyPaths = ['/sys/devices/system/cpu', '/sys/devices/system/node'].filter(existsSync);
  const configPaths = (args.configPaths || []).filter(existsSync);
  const strict = args.strictReadOnlyRoots || args.env.AP_PROJECT_CAPABILITY_SOCKET || args.env.AP_PROJECT_CAPABILITIES_JSON;
  const explicitReadOnlyPaths = args.readOnlyPaths?.filter(existsSync).flatMap((source) => {
    const resolved = realpathSync(source);
    return strict ? [resolved] : [resolved, ...symlinkTargets(resolved)];
  });
  const writableMounts = configPaths.map((source) => realpathSync(source))
    .filter((source) => !isWithin(workspaceRoot, source));
  const extraWritableMounts = (args.sandboxMode === 'read-only' ? [] : args.writableRoots || [])
    .filter(existsSync)
    .map((source) => realpathSync(source))
    .filter((source) => !isWithin(workspaceRoot, source));
  const outputs = (args.outputPaths || []).filter(existsSync).map((entry) => {
    const canonical = realpathSync(entry);
    if (canonical === workspaceRoot || !isWithin(workspaceRoot, canonical)) throw new Error('Output path escapes the task workspace');
    return canonical;
  });
  const runtimeOutputs = sandboxOutputBindings(args.env, workspaceRoot, args.readOnlyPaths?.filter(existsSync) || []);
  const allWritableMounts = [...writableMounts, ...extraWritableMounts, ...outputs]
    .filter((source, index, all) => all.indexOf(source) === index);
  const readOnlyMounts = [
    executableMount,
    ...localToolchainPaths(),
    ...(project ? [project.directory] : []),
    ...systemTopologyPaths,
    ...(explicitReadOnlyPaths ?? configPaths.flatMap(symlinkTargets)),
  ]
    .filter((source, index, all) => !source.startsWith('/usr/') && all.indexOf(source) === index);
  const bwrapArgs = [
    '--die-with-parent', '--new-session', '--unshare-all',
    ...sandboxEnvironmentRemovals(args.env).flatMap((key) => ['--unsetenv', key]),
    ...Object.entries(project?.env || {}).flatMap(([key, value]) => ['--setenv', key, value]),
    ...(args.networkAccess === 'enabled' ? ['--share-net'] : []),
    '--tmpfs', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/usr', '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    ...(existsSync(systemCertificates) ? [...parentDirs(systemCertificates), '--ro-bind', systemCertificates, systemCertificates] : []),
    ...(existsSync(systemHosts) ? [...parentDirs(systemHosts), '--ro-bind', realpathSync(systemHosts), systemHosts] : []),
    ...(existsSync(systemResolvConf) ? [...parentDirs(systemResolvConf), '--ro-bind', realpathSync(systemResolvConf), systemResolvConf] : []),
    ...parentDirs(workspaceRoot), args.sandboxMode === 'read-only' ? '--ro-bind' : '--bind', workspaceRoot, workspaceRoot,
    ...allWritableMounts.flatMap((source) => [...parentDirs(source), '--bind', source, source]),
    ...readOnlyMounts.flatMap((source) => [...parentDirs(source), '--ro-bind', source, source]),
    ...runtimeOutputs.flatMap(({ source, target, readOnly }) => [...parentDirs(target), readOnly ? '--ro-bind' : '--bind', source, target]),
    '--chdir', cwd,
    invocation,
    ...args.commandArgs,
  ];
  return { command: '/usr/bin/bwrap', args: bwrapArgs };
}
