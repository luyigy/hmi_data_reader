import { prepareSandboxEnvironment, type SandboxEnvironmentInput } from '../sandbox-manager/environment';
import { assertBubblewrapAvailable, renderBubblewrap } from '../sandbox-manager/bubblewrap';

export function wrapWithBubblewrap(args: Omit<SandboxEnvironmentInput, 'workspaceRoot'> & { workspaceRoot?: string }) {
  if (!args.workspaceRoot) return { command: args.command, args: args.commandArgs };
  assertBubblewrapAvailable();
  return renderBubblewrap(prepareSandboxEnvironment({ ...args, workspaceRoot: args.workspaceRoot }));
}
