import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { initialExecutionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { diagnoseExecution, diagnoseTaskGraphRun } from '../src/lib/task-graph/run-doctor';

async function main() {
  const parent = await prisma.task.create({ data: { name: 'Run doctor fixture' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'test://doctor', nodes: ['A', 'B', 'C'].map(key => ({ key, goal: key, dependsOn: key === 'C' ? ['A'] : [],
      acceptance: { mode: 'automatic', checks: ['fixture-check'] }, executions: [{ key: 'repo', instructions: 'fixture',
        repository: '/tmp/run-doctor-fixture', gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex' }] })) } });
  const nodes = await prisma.taskGraphNode.findMany({ where: { runId: run.id }, include: { executions: true } });
  const a = nodes.find(node => node.key === 'A'), b = nodes.find(node => node.key === 'B'); assert.ok(a && b);
  const progress = { ...initialExecutionProgress(), phase: 'implement' as const, state: 'waiting_decision' as const,
    candidateCommit: 'b'.repeat(40), workspaceBase: 'a'.repeat(40),
    lastFailure: { code: 'missing_upstream_input', detail: 'Reader identity/sample/page_id not bound', owner: 'platform' as const } };
  await prisma.taskGraphNode.update({ where: { id: a.id }, data: { status: 'attention' } });
  await prisma.taskGraphExecution.update({ where: { id: a.executions[0].id }, data: { status: 'attention', dispatchMetadata: metadataWithProgress({}, progress) } });
  await prisma.taskGraphNode.update({ where: { id: b.id }, data: { status: 'ready' } });
  await prisma.taskGraphExecution.update({ where: { id: b.executions[0].id }, data: { status: 'ready' } });
  const before = JSON.stringify({ nodes: await prisma.taskGraphNode.findMany({ where: { runId: run.id }, include: { executions: true } }),
    events: await prisma.taskGraphEvent.findMany({ where: { runId: run.id } }), run: await prisma.taskGraphRun.findUnique({ where: { id: run.id } }) });
  const report = await diagnoseTaskGraphRun(run.id, prisma, async () => { throw new Error('probe deliberately failed'); });
  assert.equal(report.readOnly, true);
  assert.equal(report.categoryCounts.waiting_dependencies, 1);
  assert.equal(Object.values(report.categoryCounts).reduce((sum, count) => sum + count, 0), 3);
  assert.equal(report.nodes.find(node => node.key === 'A')?.category, 'platform_recoverable');
  assert.equal(report.nodes.find(node => node.key === 'B')?.category, 'eligible');
  assert.equal(report.nodes.find(node => node.key === 'C')?.category, 'waiting_dependencies');
  const diagnostic = report.nodes.find(node => node.key === 'A')?.jobs[0]; assert.ok(diagnostic && 'automaticProgress' in diagnostic);
  assert.equal(diagnostic.automaticProgress.status, 'stalled');
  assert.match(diagnostic.transition.failure || '', /attention\/waiting_decision/);
  assert.equal(diagnostic.gates.environment.state, 'not_verified');
  assert.equal(diagnostic.gates.recoveryAuthorization.state, 'not_verified');
  assert.equal(report.approval.check.state, 'not_verified');
  assert.equal(JSON.stringify({ nodes: await prisma.taskGraphNode.findMany({ where: { runId: run.id }, include: { executions: true } }),
    events: await prisma.taskGraphEvent.findMany({ where: { runId: run.id } }), run: await prisma.taskGraphRun.findUnique({ where: { id: run.id } }) }), before);
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await assert.rejects(tx.taskGraphRun.update({ where: { id: run.id }, data: { status: 'completed' } }), /read.only/i);
  });
  const job = a.executions[0];
  const base = { job: { ...job, status: 'attention', dispatchMetadata: metadataWithProgress({}, progress) }, nodeStatus: 'attention',
    dependencies: { state: 'verified' as const, evidence: 'passed' }, approval: { state: 'not_verified' as const, evidence: 'unknown' }, taskRun: null,
    writer: { observation: { kind: 'exited' as const }, startedAt: '', finishedAt: '' }, now: new Date() };
  const material = diagnoseExecution({ ...base, job: { ...base.job, dispatchMetadata: metadataWithProgress({}, { ...progress, lastFailure: { code: 'missing_business_material', detail: 'Need screenshot' } }) } });
  assert.equal(material.category, 'business_material'); assert.match(material.failure?.evidenceStatus || '', /未独立验证/);
  const stale = diagnoseExecution({ ...base, job: { ...base.job, status: 'ready', dispatchMetadata: metadataWithProgress({}, { ...progress, state: 'ready', lastFailure: { code: 'missing_business_material', detail: 'old' } }) } });
  assert.equal(stale.category, 'eligible', 'resumed jobs must not reuse historical failure classification');
  const unrelatedBudget = diagnoseExecution({ ...base, job: { ...base.job, dispatchMetadata: metadataWithProgress({}, { ...progress, formatAttempts: 1 }) } });
  assert.notEqual(unrelatedBudget.category, 'budget_exhausted', 'unused budget exhaustion is not a global stop');
  const exhausted = diagnoseExecution({ ...base, job: { ...base.job, dispatchMetadata: metadataWithProgress({}, { ...progress, state: 'exhausted' }) } });
  assert.equal(exhausted.category, 'budget_exhausted');
  assert.equal(diagnoseExecution({ ...base, writer: { ...base.writer, observation: { kind: 'unknown', reason: 'unreadable descendant' } } }).category, 'writer_unknown');
  const live = diagnoseExecution({ ...base, job: { ...base.job, status: 'claimed' }, writer: { ...base.writer, observation: { kind: 'alive', pids: [123] } } });
  assert.equal(live.category, 'running'); assert.notEqual(live.automaticProgress.status, 'verified');
  const defect = diagnoseExecution({ ...base, job: { ...base.job, dispatchMetadata: metadataWithProgress({}, { ...progress, lastFailure: { code: 'test_failed', detail: 'test red' } }) } });
  assert.equal(defect.category, 'code_defect'); assert.equal(defect.relevantBudget, 'repairAttempts');
  assert.equal(diagnoseExecution({ ...base, nodeStatus: 'awaiting_human', job: { ...base.job, status: 'integrated' } }).category, 'decision');
  assert.equal(diagnoseExecution({ ...base, nodeStatus: 'claimed', job: { ...base.job, status: 'integrated' } }).category, 'review');
  assert.equal(diagnoseExecution({ ...base, dependencies: { state: 'failed', evidence: 'missing A' } }).category, 'waiting_dependencies');
  await prisma.taskGraphNode.update({ where: { id: b.id }, data: { dependsOn: ['missing-node'] } });
  const drift = await diagnoseTaskGraphRun(run.id);
  assert.equal(drift.nodes.find(node => node.key === 'B')?.snapshotBinding.state, 'failed');
  const proposal = await prisma.taskGraphProposal.create({ data: { parentTaskId: parent.id, version: 1, snapshotHash: run.snapshotHash,
    definition: run.snapshot ?? {}, status: 'confirmed', createdBy: 'fixture', decidedBy: 'fixture-admin', decidedAt: new Date() } });
  await prisma.taskGraphRun.update({ where: { id: run.id }, data: { requestKey: `feishu-proposal:${proposal.id}` } });
  assert.equal((await diagnoseTaskGraphRun(run.id)).approval.check.state, 'verified');
  await prisma.taskGraphRun.update({ where: { id: run.id }, data: { snapshotHash: 'wrong-hash' } });
  assert.equal((await diagnoseTaskGraphRun(run.id)).approval.check.state, 'failed');
  await prisma.taskGraphRun.update({ where: { id: run.id }, data: { snapshotHash: run.snapshotHash } });
  await prisma.taskGraphExecution.update({ where: { id: a.executions[0].id }, data: { taskRunId: 'missing-probe-target' } });
  const failedProbe = await diagnoseTaskGraphRun(run.id, prisma, async () => { throw new Error('probe deliberately failed'); });
  assert.equal(failedProbe.nodes.find(node => node.key === 'A')?.category, 'writer_unknown');
  assert.equal(failedProbe.nodes.length, 3, 'one probe failure must not truncate run diagnosis');
  console.log('Run doctor classifies stranded transitions, preserves unknown gates, isolates writer failures and enforces read-only SQL.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
