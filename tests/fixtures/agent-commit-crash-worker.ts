import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { getHarnessAdapter } from '../../src/lib/harness';
import { wrapWithBubblewrap } from '../../src/lib/harness/bubblewrap';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../../src/lib/task-graph/coordinator';

// Kill the real coordinator after ACPX has completed its TaskRun, before result intake.
require('../../src/lib/task-graph/task-run-result').recordedImplementationResult = async () => process.exit(71);
require('../../src/lib/task-graph/worktree').commitJobWorktree = async () => { throw new Error('Platform commit during restart fixture'); };
const adapter = getHarnessAdapter('codex')!;
adapter.execute = async args => {
  const cwd = args.context.workingDirectory;
  const wrapped = wrapWithBubblewrap({ command: '/bin/sh', commandArgs: ['-ec',
    'printf good > value; test "$(cat value)" = good; git add value; git -c core.hooksPath=/dev/null commit -m "Agent before crash"; git rev-parse HEAD'],
    cwd, workspaceRoot: cwd, writableRoots: args.context.extraWritableRoots, readOnlyPaths: args.context.extraReadOnlyPaths,
    env: { ...process.env, ...args.context.taskEnvironment } });
  const child = spawn(wrapped.command, wrapped.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = ''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => error += value);
  args.context.onSpawn?.(child); const [code] = await once(child, 'exit'); assert.equal(code, 0, error);
  const status = process.argv[2] || 'delivered';
  return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION ' + JSON.stringify({ status, note: 'Agent completed before coordinator crash',
    commit: output.trim().split('\n').at(-1), evidence: ['test value=good'], ...(status === 'blocked' ? { blockerKind: 'missing_business_material' } : {}) }), executionTime: 1 };
};
adapter.resume = async args => adapter.execute(args);
(async () => {
  await runTaskGraphCycle();
  const controller = new AbortController(); controller.abort(); await startTaskGraphCoordinator(controller.signal);
  throw new Error('Fixture failed to reach result intake');
})().catch(error => { console.error(error); process.exit(72); });
