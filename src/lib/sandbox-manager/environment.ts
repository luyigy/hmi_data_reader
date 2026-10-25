import { pinnedSandboxPython } from '../project-capabilities/python-runtime';
import { sandboxOutputBindings } from '../harness/output-bindings';
import { sandboxProjectEnvironment } from '../harness/project-environment';
import { sandboxEnvironmentRemovals } from '../harness/sandbox-env';
import { localToolchainPaths } from '../harness/toolchain-paths';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export type SandboxEnvironmentInput = {
  command: string;
  commandArgs: string[];
  cwd: string;
  workspaceRoot: string;
  writableRoots?: string[];
  outputPaths?: string[];
  networkAccess?: 'restricted' | 'enabled';
  sandboxMode?: string;
  env: NodeJS.ProcessEnv;
  configPaths?: string[];
  readOnlyPaths?: string[];
  strictReadOnlyRoots?: boolean;
};

const executablePath = (command: string, env: NodeJS.ProcessEnv) => {
  if (command.includes('/')) return realpathSync(command);
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(directory, command);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`找不到本地 harness：${command}`);
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

/** Prepare the resources already selected by the caller; this does not grant access. */
export function prepareSandboxEnvironment(args: SandboxEnvironmentInput) {
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
  const configPaths = (args.configPaths || []).filter(existsSync);
  const strict = args.strictReadOnlyRoots || args.env.AP_RESOURCE_SCOPE === '1' || args.env.AP_PROJECT_CAPABILITY_SOCKET || args.env.AP_PROJECT_CAPABILITIES_JSON;
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
  const automaticReadOnlyMounts = [
    executableMount,
    ...localToolchainPaths(),
    ...(project ? [project.directory] : []),
  ];
  return {
    workspaceRoot, cwd, invocation, commandArgs: args.commandArgs,
    env: launchEnv,
    environmentRemovals: sandboxEnvironmentRemovals(args.env),
    environmentOverrides: project?.env || {},
    networkAccess: args.networkAccess,
    sandboxMode: args.sandboxMode,
    writableMounts: allWritableMounts,
    automaticReadOnlyMounts,
    explicitReadOnlyMounts: explicitReadOnlyPaths ?? configPaths.flatMap(symlinkTargets),
    runtimeOutputs,
  };
}

export type PreparedSandboxEnvironment = ReturnType<typeof prepareSandboxEnvironment>;
