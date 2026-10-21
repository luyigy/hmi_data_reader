import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { prisma } from '../src/lib/prisma';
import { claimExecution, claimNode, createTaskGraphRun, refreshTaskGraphRunStatus, releaseReadyNodes } from '../src/lib/task-graph/store';
import { requireGraphNodeActive, setGraphRunPaused, stopPausedGraphTurns } from '../src/lib/task-graph/run-control';
import { registerRunningProcess, clearRunningProcess } from '../src/lib/acpx/process-registry';
import { pendingConversationInputs } from '../src/lib/task-graph/conversation-inbox';
import { reserveGraphReviewClaim } from '../src/lib/task-graph/review-ownership';
import { bindExecutionTaskRun } from '../src/lib/task-graph/execution-progress';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const parent = await prisma.task.create({ data: { name: `pause-${randomUUID()}` } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://persistent-ticket-pause', nodes: ['A', 'B'].map(key => ({ key, goal: key, dependsOn: [], executionMode: 'implement',
      acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'repo', repository: '/tmp/pause-fixture',
        gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'fixture' }] })),
  } });
  try {
    const control = { runId: run.id, paused: true, actorId: 'test-operator', requestId: 'pause-1', reason: 'manual takeover' };
    const first = await setGraphRunPaused(control);
    assert.equal((await setGraphRunPaused(control)).id, first.id);
    await assert.rejects(setGraphRunPaused({ ...control, paused: false }), /identity changed/);
    assert.deepEqual(await releaseReadyNodes(run.id), [], 'User pause must prevent successor release');
    await refreshTaskGraphRunStatus(run.id);
    assert.equal((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).status, 'paused', 'Projection cannot erase user pause');
    const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'A' } } });
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'ready' } });
    await prisma.taskGraphExecution.updateMany({ where: { nodeId: node.id }, data: { status: 'ready' } });
    assert.equal(await claimNode(run.id, 'A', 'new-writer'), null, 'A preselected ready job cannot bypass pause');
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'claimed', claimToken: 'old-writer' } });
    assert.equal(await claimExecution(run.id, 'A', 'repo', 'old-writer'), null, 'In-flight node claim cannot start another writer');
    await assert.rejects(requireGraphNodeActive(node.id), /paused by the user/);
    assert.equal(await reserveGraphReviewClaim({ runId: run.id, nodeId: node.id, phase: 'acceptance', claimKey: 'new-review', payload: {} }), false);
    const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } });
    await assert.rejects(prisma.$transaction(tx => bindExecutionTaskRun(tx, { executionId: job.id, claimToken: 'old-writer', revision: 0 }, 'fake-turn')), /paused by the user/);
    await prisma.taskGraphEvent.create({ data: { runId: run.id, nodeId: node.id, kind: 'conversation_input', idempotencyKey: 'material',
      payload: { executionId: job.id, sourceId: 'user-reply', actorId: 'test-operator', content: 'new material', receivedPhase: 'implement', receivedState: 'active' } } });
    assert.deepEqual(await pendingConversationInputs(prisma, run.id, job.id), [], 'Paused input remains unconsumed');
    const saved = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    await setGraphRunPaused({ ...control, paused: false, requestId: 'resume-1', reason: 'explicit continue' });
    assert.equal((await pendingConversationInputs(prisma, run.id, job.id)).length, 1, 'Explicit resume exposes queued input exactly once');
    assert.deepEqual(await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } }), saved, 'Control cannot reset claims, sessions, candidates or budgets');
    await setGraphRunPaused({ ...control, requestId: 'pause-2' });
    await setGraphRunPaused({ ...control, paused: false, requestId: 'resume-1', reason: 'explicit continue' });
    assert.equal((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).status, 'paused', 'A replayed old resume cannot undo a newer pause');
    assert.equal((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).snapshotHash, run.snapshotHash);
    const childTask = await prisma.task.create({ data: { name: 'owned turn fixture' } });
    const turn = await prisma.taskRun.create({ data: { taskId: childTask.id, status: 'running', participants: { create: {
      gatewayId: 'platform-local', gatewayNameSnapshot: 'Local', role: 'implementer', runner: 'codex', executionBackend: 'platform_local', harnessType: 'codex', status: 'running',
    } } }, include: { participants: true } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: childTask.id, taskRunId: turn.id } });
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'exit');
    registerRunningProcess({ taskRunId: turn.id, participantId: turn.participants[0].id, child, executionBackend: 'platform_local', harnessType: 'codex' });
    try {
      await once(child.stdout, 'data');
      await stopPausedGraphTurns();
      await closed;
      assert.equal((await prisma.taskRun.findUniqueOrThrow({ where: { id: turn.id } })).controlState, 'stop_requested');
      assert.equal((await prisma.taskRun.findUniqueOrThrow({ where: { id: turn.id } })).status, 'running', 'A stop request must not fabricate terminal status or writer exit');
    } finally {
      clearRunningProcess(turn.participants[0].id, turn.id);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: null, taskRunId: null } });
      await prisma.taskRun.delete({ where: { id: turn.id } });
      await prisma.task.delete({ where: { id: childTask.id } });
    }
    console.log('T0: user pause blocks release, projection overwrite, stale dispatch and execution claim');
  } finally {
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    await prisma.task.delete({ where: { id: parent.id } });
    await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
