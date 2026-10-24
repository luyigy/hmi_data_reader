import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { initialExecutionProgress } from '../src/lib/task-graph/execution-progress';
import { prepareGraphOutputForTask } from '../src/lib/task-graph/output-task-context';
import { inspectImplementationConditions } from '../src/lib/task-graph/preparation-recovery';
import { validationRuntimeDirectory } from '../src/lib/task-graph/acceptance-runtime';
import * as git from '../src/lib/task-graph/git-command';
import * as upstream from '../src/lib/task-graph/upstream-inputs';
import * as spec from '../src/lib/task-graph/spec-input';
import * as runtime from '../src/lib/task-graph/runtime-continuity';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'condition-output-'));
  const previous = process.env.TASK_GRAPH_VALIDATION_ROOT;
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const parent = await prisma.task.create({ data: { name: 'condition output regression' } });
  const child = await prisma.task.create({ data: { name: 'original coding task' } });
  const definition = { specRef: 'test://conditions', nodes: [{ key: 'A', goal: 'conditions', dependsOn: [], executionMode: 'implement' as const,
    acceptance: { mode: 'automatic' as const, checks: [] }, executions: [{ key: 'repo', repository: root,
      gitRef: 'main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'fixture' }] }] };
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition });
  try {
    const original = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id } } });
    const job = await prisma.taskGraphExecution.update({ where: { id: original.id }, data: { childTaskId: child.id, worktreePath: root } });
    const harness = await prepareGraphOutputForTask(child.id, 'harness:original', []);
    await fs.writeFile(path.join(harness.directory, 'evidence.txt'), 'original evidence');
    mock.method(git, 'graphGit', async (_root: string, ...args: string[]) => {
      if (args.includes('MERGE_HEAD')) throw new Error('no merge');
      return 'a'.repeat(40);
    });
    mock.method(upstream, 'prepareUpstreamInputs', async () => ({ readOnlyPaths: [], manifest: { hash: 'inputs' } }));
    mock.method(spec, 'prepareGraphSpecInput', async () => ({ paths: [] }));
    let fail = false;
    const directories = new Set<string>();
    mock.method(runtime, 'inspectSavedTaskRuntime', async (args: Parameters<typeof runtime.inspectSavedTaskRuntime>[0]) => {
      directories.add(args.outputDirectory);
      assert.ok(args.approvedReadOnlyRoots.includes(harness.directory), 'original evidence remains readable');
      assert.ok(!args.approvedReadOnlyRoots.some(item => directories.has(item)), 'probe scratch is never a historical artifact');
      await fs.writeFile(path.join(args.outputDirectory, 'probe.json'), JSON.stringify({ fail }));
      if (fail) throw new Error('probe failed');
      return { identity: 'runtime' };
    });
    for (let revision = 0; revision < 100; revision++) {
      fail = revision % 2 === 1;
      const inspect = inspectImplementationConditions(job, { ...initialExecutionProgress(), revision,
        workspaceBase: 'a'.repeat(40), candidateCommit: 'a'.repeat(40) }, definition, run.id);
      if (fail) await assert.rejects(inspect, /probe failed/); else await inspect;
    }
    assert.equal(directories.size, 1, 'success/failure and advancing revisions must reuse one scratch directory');
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: job.nodeId, kind: 'output_runtime_prepared' } }), 1,
      'readiness polling must not publish output artifacts');
    assert.equal((await fs.readdir(validationRuntimeDirectory(job.nodeId))).length, 2);
    const next = await prepareGraphOutputForTask(child.id, 'harness:next', []);
    assert.deepEqual(next.readOnlyPaths, [harness.directory]);
    assert.equal(await fs.readFile(path.join(harness.directory, 'evidence.txt'), 'utf8'), 'original evidence');
    console.log('100 changing-revision checks (including 50 failures) reuse one scratch directory without publishing or mounting probe outputs; real evidence stays intact');
  } finally {
    mock.restoreAll();
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    await prisma.task.deleteMany({ where: { id: { in: [parent.id, child.id] } } });
    await prisma.$disconnect();
    if (previous === undefined) delete process.env.TASK_GRAPH_VALIDATION_ROOT; else process.env.TASK_GRAPH_VALIDATION_ROOT = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
