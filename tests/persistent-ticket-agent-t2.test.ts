import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, claimNode, claimExecution, releaseReadyNodes } from '../src/lib/task-graph/store';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { getHarnessAdapter } from '../src/lib/harness';
import { executionProgress, applyExecutionOutcome } from '../src/lib/task-graph/execution-progress';
import type { HarnessExecuteArgs, HarnessResumeArgs } from '../src/lib/harness/types';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = mkdtempSync(path.join(os.tmpdir(), 'persistent-review-')), repo = path.join(root, 'repo'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost');
  writeFileSync(path.join(repo, 'value'), '0'); git('add', '.'); git('commit', '-m', 'base');
  process.env.AP_WORKSPACE_ROOT = path.join(root, 'central'); process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime'); process.env.TASK_GRAPH_UPSTREAM_ROOT = path.join(root, 'inputs');
  const require = createRequire(__filename), feishu = require('../src/lib/task-graph/feishu');
  feishu.postGraphParentProgress = async () => {}; feishu.postGraphChildProgress = async () => {};
  const adapter = getHarnessAdapter('codex')!, original = { execute: adapter.execute, resume: adapter.resume };
  let implementations = 0, reviews = 0, next = 0;
  const calls: { session: string | null; readOnly: boolean }[] = [];
  const execute = async (args: HarnessExecuteArgs | HarnessResumeArgs) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: { ...process.env, ...args.context.taskEnvironment }, stdio: 'ignore' });
    args.context.onSpawn?.(child); await once(child, 'exit');
    if (args.task.id.startsWith('task-graph-review-')) {
      reviews++;
      const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { key: 'A', runId: run.id } } });
      assert.ok(job.worktreePath && args.context.extraReadOnlyPaths?.includes(job.worktreePath), 'Fixed candidate source must be mounted readonly while review outputs remain writable');
      const value = Number(readFileSync(path.join(job.worktreePath!, 'value'), 'utf8'));
      return { success: true, output: 'TASK_GRAPH_REVIEW ' + JSON.stringify(value >= 4 ? { approved: true, note: 'value reached 4' }
        : { approved: false, failureKind: 'in_scope_defect', note: 'value must reach 4', failureKey: 'acceptance:value', executionIds: [job.id] }), executionTime: 1 };
    }
    if (args.task.name.startsWith('NEXT')) next++;
    else {
      implementations++; calls.push({ session: 'sessionId' in args ? args.sessionId : null, readOnly: args.context.permissionConfig?.sandboxMode === 'read-only' });
      if (implementations > 1) assert.equal('sessionId' in args ? args.sessionId : null, 'original-native');
      writeFileSync(path.join(args.context.workingDirectory, 'value'), String(implementations));
    }
    return { success: true, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"candidate","evidence":["value"]}', sessionId: 'original-native', sessionKind: 'codex_thread', executionTime: 1 };
  };
  adapter.execute = execute; adapter.resume = execute;
  const parent = await prisma.task.create({ data: { name: 'persistent review feedback' } });
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://review-feedback', nodes: ['A', 'NEXT'].map(key => ({ key, goal: key, dependsOn: key === 'NEXT' ? ['A'] : [], executionMode: 'lean',
      acceptance: { mode: key === 'A' ? 'agent' : 'automatic', checks: ['value'], ...(key === 'A' ? { reviewerId: 'local:codex', reviewLaunchConfig: { participant: { ...participant, role: 'tester' } } } : {}) },
      executions: [{ key: 'repo', repository: repo, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'local:codex', instructions: 'Approved final value must be 4',
        launchConfig: { participant, checks: [{ name: 'value', argv: ['node', '-e', "require('fs').accessSync('value')"] }] } }] })),
  } });
  let stalledRunId: string | undefined;
  try {
    for (let i = 0; i < 450; i++) {
      await runTaskGraphCycle();
      const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'A' } } });
      const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } });
      if (executionProgress(job.dispatchMetadata)?.state === 'exhausted') throw new Error('Changing approved candidates were blocked: ' + JSON.stringify({ implementations, reviews, progress: executionProgress(job.dispatchMetadata), events: await prisma.taskGraphEvent.findMany({ where: { nodeId: node.id }, orderBy: { createdAt: 'desc' }, take: 4 }) }));
      if (next) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal);
    const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'A' } } });
    assert.equal(node.status, 'passed'); assert.equal(implementations, 4); assert.equal(reviews, 4); assert.equal(next, 1);
    assert.ok(calls.every(call => !call.readOnly));
    const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } });
    assert.equal(executionProgress(job.dispatchMetadata)?.repairAttempts, 3, 'History remains truthful instead of resetting budgets');
    const stalledRun = await createTaskGraphRun({ parentTaskId: parent.id, version: 2, requestKey: parent.id + ':stalled', definition: {
      specRef: 'test://unchanged-repair', nodes: [{ key: 'A', goal: 'same failure', dependsOn: [], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] },
        executions: [{ key: 'repo', repository: repo, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'local:codex', instructions: 'fixture' }] }],
    } });
    stalledRunId = stalledRun.id;
    await releaseReadyNodes(stalledRun.id); await claimNode(stalledRun.id, 'A', 'stalled-node');
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = `stalled-${attempt}`, claimed = await claimExecution(stalledRun.id, 'A', 'repo', token); assert.ok(claimed);
      const before = executionProgress(claimed.dispatchMetadata);
      const checkpoint = await applyExecutionOutcome({ executionId: claimed.id, claimToken: token, expectedRevision: before?.revision || 0,
        outcomeId: `check-${attempt}`, outcome: { kind: 'checkpoint', phase: 'check', workspaceBase: git('rev-parse', 'HEAD'), candidateCommit: git('rev-parse', 'HEAD') } });
      const next = await applyExecutionOutcome({ executionId: claimed.id, claimToken: token, expectedRevision: checkpoint.revision,
        outcomeId: `same-defect-${attempt}`, outcome: { kind: 'repair_required', failure: { code: 'test_failed', detail: 'same failure', tree: git('rev-parse', 'HEAD^{tree}'), fingerprint: 'f'.repeat(64) } } });
      assert.equal(next.state, attempt < 3 ? 'ready' : 'waiting_for_user');
      if (attempt === 3) { assert.equal(next.repairAttempts, 3); assert.equal(next.candidateCommit, git('rev-parse', 'HEAD')); }
    }
    console.log('T2: three distinct verified defects return to the same native implementer; four fixed candidates independently reviewed, successor released once; historical counters preserved');
  } finally { const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal);
    adapter.execute = original.execute; adapter.resume = original.resume; if (stalledRunId) await prisma.taskGraphRun.delete({ where: { id: stalledRunId } });
    await prisma.taskGraphRun.delete({ where: { id: run.id } }); await prisma.$disconnect(); rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
