import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { initialExecutionProgress, executionProgress, metadataWithProgress, type ExecutionProgress } from '../src/lib/task-graph/execution-progress';
import { receiveGraphTaskMessage, reconcileConversationWaits, conversationInputs, bindConversationInputs } from '../src/lib/task-graph/conversation-inbox';
import { exitedGraphWriter } from './fixtures/exited-graph-writer';
import { parseImplementationResult } from '../src/lib/task-graph/implementation-result';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const require = createRequire(__filename);
  require('../src/lib/task-graph/feishu').postGraphChildProgress = async () => {};
  const phase: typeof import('../src/lib/task-graph/phase-worker') = require('../src/lib/task-graph/phase-worker');
  const realObservation = phase.observeExecutionWriter;
  const cases: { key: string; expected?: 'ready'; progress?: Partial<ExecutionProgress>; issue?: string; status?: string; nodeStatus?: string; unauthorized?: boolean; noCandidate?: boolean; noClaim?: boolean; wrongRunOwner?: boolean; observation?: 'alive' | 'unknown'; race?: 'revision' | 'candidate'; dependencies?: boolean; review?: 'completed' | 'running'; topic?: 'valid' | 'wrong' | 'recovery' }[] = [
    { key: 'FEISHU_TOPIC', topic: 'valid', expected: 'ready' }, { key: 'FEISHU_RECOVERED_INPUT', topic: 'recovery', expected: 'ready' }, { key: 'WRONG_TOPIC', topic: 'wrong' },
    { key: 'AFTER_REVIEW_REPAIR', review: 'completed', expected: 'ready', progress: { repairAttempts: 1 } }, { key: 'REVIEW_NOT_FINISHED', review: 'running' },
    { key: 'QUESTION', expected: 'ready' }, { key: 'ANSWERED', expected: 'ready', progress: { waitingKind: 'answered' } },
    { key: 'LAST_LEGAL_ATTEMPT', expected: 'ready', progress: { repairAttempts: 2, platformAttempts: 2, formatAttempts: 1, integrationAttempts: 3 } },
    { key: 'ENVIRONMENT', progress: { state: 'waiting_decision', lastFailure: { code: 'environment_failed', detail: 'runtime missing' } }, issue: 'environment_failed' },
    { key: 'BINDING', progress: { state: 'waiting_decision', lastFailure: { code: 'missing_upstream_input', detail: 'unbound package' } } },
    { key: 'SCOPE', progress: { state: 'waiting_decision', lastFailure: { code: 'scope_change', detail: 'scope pending' } } },
    { key: 'PERMISSION', progress: { state: 'waiting_decision', lastFailure: { code: 'permission_required', detail: 'grant pending' } } },
    { key: 'EXHAUSTED', progress: { state: 'exhausted', platformAttempts: 2 } },
    { key: 'CHECK', progress: { phase: 'check' } }, { key: 'INTEGRATE', progress: { phase: 'integrate' } },
    { key: 'ACCEPTANCE', progress: { phase: 'acceptance' }, nodeStatus: 'verifying' },
    { key: 'DELIVERED', status: 'integrated', nodeStatus: 'passed' },
    { key: 'ALIVE', observation: 'alive' }, { key: 'UNKNOWN', observation: 'unknown' },
    { key: 'NO_CANDIDATE', noCandidate: true }, { key: 'NO_CLAIM', noClaim: true },
    { key: 'UNAUTHORIZED', unauthorized: true }, { key: 'WRONG_TASK_RUN', wrongRunOwner: true },
    { key: 'REVISION_RACE', race: 'revision' }, { key: 'CANDIDATE_RACE', race: 'candidate' },
    { key: 'DEPENDENCY', dependencies: true },
    { key: 'OLD_FOLLOWUP', progress: { conversation: { kind: 'reserved', reservationId: 'historical-reservation' } } },
  ];
  const owner = await prisma.user.create({ data: { username: randomUUID(), passwordHash: 'fixture', role: 'user' } });
  const parent = await prisma.task.create({ data: { name: 'continuation matrix', ownerUserId: owner.id } });
  const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'test://continuation-matrix', nodes: cases.map(test => ({
    key: test.key, goal: test.key, dependsOn: test.dependencies ? ['QUESTION'] : [], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'job', repository: '/tmp/continuation-matrix', gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'approved scope' }],
  })) } });
  const departed = await exitedGraphWriter();
  const rows = new Map<string, Awaited<ReturnType<typeof prisma.taskGraphExecution.findUniqueOrThrow>>>();
  try {
    await prisma.taskGraphRun.update({ where: { id: graph.id }, data: { status: 'attention' } });
    for (const test of cases) {
      const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: graph.id, key: test.key } } });
      const child = await prisma.task.create({ data: { id: `task-graph-${job.id}`, name: test.key } });
      const run = await prisma.taskRun.create({ data: { taskId: test.wrongRunOwner ? parent.id : child.id, status: 'completed', summary: 'normal turn', mode: 'acpx' } });
      const progress: ExecutionProgress = { ...initialExecutionProgress(), phase: 'implement', state: 'waiting_for_user', candidateCommit: 'a'.repeat(40), workspaceBase: 'a'.repeat(40), taskRunId: run.id, ...test.progress };
      if (test.review) {
        const reviewTask = await prisma.task.upsert({ where: { id: `task-graph-review-${job.nodeId}` }, create: { id: `task-graph-review-${job.nodeId}`, name: 'review' }, update: {} });
        const reviewRun = await prisma.taskRun.create({ data: { taskId: reviewTask.id, mode: 'acpx', status: test.review, controlMetadata: JSON.stringify({ graphWriter: departed }), participants: { create: { gatewayNameSnapshot: 'local', runner: 'codex', harnessType: 'codex', executionBackend: 'platform_local', role: 'reviewer', status: test.review } } } });
        progress.review = { kind: 'running', phase: 'acceptance', claimKey: 'previous-review', candidateCommit: 'a'.repeat(40), taskRunId: reviewRun.id };
      }
      if (test.noCandidate) delete progress.candidateCommit;
      await prisma.taskGraphNode.update({ where: { id: job.nodeId }, data: { status: test.nodeStatus || 'attention' } });
      rows.set(test.key, await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: test.status || 'attention', childTaskId: child.id, claimToken: test.noClaim ? null : `claim-${test.key}`, taskRunId: run.id, worktreePath: '/tmp/continuation-matrix/job', dispatchMetadata: { progress }, issueKind: test.issue || null } }));
      const input = { taskId: child.id, sourceId: `answer-${test.key}`, actorId: test.unauthorized ? 'stranger' : owner.id, actorOrigin: 'platform' as const, content: '新材料，请核对当前范围。' };
      if (test.topic) {
        const room = await prisma.liveRoom.create({ data: { title: test.key, sourceTaskId: test.topic === 'wrong' ? parent.id : child.id } });
        const metadata = JSON.stringify({ source: 'feishu', feishuSenderOpenId: 'topic-user', feishuMessageId: `om_${job.id}` });
        const message = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: input.content, metadata } });
        const topicInput = { ...input, actorId: 'topic-user', actorOrigin: 'feishu' as const, sourceId: `feishu:om_${job.id}`, roomMessageId: message.id, sourceMetadata: metadata };
        await Promise.all([receiveGraphTaskMessage(topicInput), receiveGraphTaskMessage(topicInput)]);
        if (test.topic === 'recovery') {
          const original = (await conversationInputs(job.id))[0];
          await prisma.$transaction(tx => bindConversationInputs(tx, job.id, [original.id], run.id));
          await prisma.taskGraphEvent.create({ data: { runId: graph.id, nodeId: job.nodeId, kind: 'conversation_input', idempotencyKey: `fixture-recovery:${original.id}`,
            payload: { ...original, rootInputId: original.id, content: `先核对投递情况：${original.content}`, sourceId: `recovered:${original.id}` } } });
        }
      } else await Promise.all([receiveGraphTaskMessage(input), receiveGraphTaskMessage(input)]);
    }
    phase.observeExecutionWriter = async job => {
      const test = cases.find(test => rows.get(test.key)?.id === Reflect.get(job, 'id'));
      assert(test);
      if (test.race) {
        const before = rows.get(test.key)!; const progress = executionProgress(before.dispatchMetadata)!;
        await prisma.taskGraphExecution.update({ where: { id: before.id }, data: { dispatchMetadata: metadataWithProgress(before.dispatchMetadata, { ...progress, ...(test.race === 'revision' ? { revision: progress.revision + 1 } : { candidateCommit: 'b'.repeat(40) }) }) } });
      }
      if (test.observation === 'alive') return { kind: 'alive', pids: [process.pid] };
      if (test.observation === 'unknown') return { kind: 'unknown', reason: 'controlled writer boundary' };
      return { kind: 'exited' };
    };
    await reconcileConversationWaits();
    const evidence = [];
    for (const test of cases) {
      const before = rows.get(test.key)!; const after = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: before.id } });
      assert.equal(after.status, test.expected || before.status, test.key);
      const p = executionProgress(after.dispatchMetadata)!; const b = executionProgress(before.dispatchMetadata)!;
      for (const counter of ['repairAttempts', 'platformAttempts', 'formatAttempts', 'integrationAttempts'] as const) assert.equal(p[counter], b[counter], `${test.key}: ${counter}`);
      assert.equal((await conversationInputs(before.id)).length, 1, `${test.key}: input is retained until bound to a TaskRun`);
      evidence.push({ case: test.key, before: before.status, after: after.status, state: p.state, revision: p.revision, candidate: p.candidateCommit, budgets: [p.repairAttempts, p.platformAttempts, p.formatAttempts, p.integrationAttempts] });
    }
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_turn_scheduled' } }), cases.filter(test => test.expected === 'ready').length);
    assert.equal(parseImplementationResult('尺寸已经核对，现在请确认颜色。', { conversation: true }).status, 'answered');
    assert.throws(() => parseImplementationResult('', { conversation: true }));
    assert.throws(() => parseImplementationResult('TASK_GRAPH_IMPLEMENTATION {broken', { conversation: true }));
    assert.throws(() => parseImplementationResult('普通说明', { conversation: false }));
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: graph.id, kind: 'conversation_followup_reserved' } }), 0);
    console.log(JSON.stringify(evidence));
  } finally {
    phase.observeExecutionWriter = realObservation;
    await prisma.taskGraphRun.delete({ where: { id: graph.id } }); await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
