import { spawn } from 'node:child_process';
import { assertBubblewrapAvailable, renderBubblewrap } from './bubblewrap';
import { prepareSandboxEnvironment, type SandboxEnvironmentInput } from './environment';
import { captureSandboxIdentity } from './identity';
import { runSandboxScope, type ManagedSandboxProcess, type SandboxScopeOptions } from './lifecycle';

export type { SandboxEnvironmentInput } from './environment';
export type { SandboxIdentity } from './identity';
export { SandboxScopeError } from './lifecycle';
export type { ManagedProcessControl, ManagedSandboxProcess, RootExit, StopRequest, SandboxScopeOptions, SandboxCleanupOutcome } from './lifecycle';

export async function withSandbox<T>(input: SandboxEnvironmentInput, use: (process: ManagedSandboxProcess) => Promise<T>, options: SandboxScopeOptions = {}): Promise<T> {
  if (!input.workspaceRoot) throw new Error('Managed sandbox requires an authorized workspace');
  assertBubblewrapAvailable();
  const plan = prepareSandboxEnvironment(input);
  const command = renderBubblewrap(plan);
  return runSandboxScope({
    start: () => spawn(command.command, command.args, { cwd: plan.cwd, env: plan.env, stdio: 'pipe', shell: false }),
    captureIdentity: captureSandboxIdentity,
    cleanup: async () => {},
  }, use, 5000, options);
}
