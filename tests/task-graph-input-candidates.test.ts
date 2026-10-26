import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, submitNodeVerification, approveHumanNode, completeUnverifiedNode } from '../src/lib/task-graph/store';
import { initialExecutionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { prepareUpstreamInputs, graphInputsForTask } from '../src/lib/task-graph/upstream-inputs';
import { registerInputCandidate, type InputCandidateReceipt } from '../src/lib/task-graph/input-candidates';
import { graphReviewClaimKey } from '../src/lib/task-graph/review-ownership';
import { runSandboxedGraphCheck } from '../src/lib/task-graph/check-environment';
import { prepareResourceWorkspaces } from '../src/lib/task-resources/graph-workspace';
import { canonicalResourceDirectories } from '../src/lib/task-resources/model';
import { assertCandidateInputsReady, assertCandidateInputsIntegrated } from '../src/lib/task-graph/candidate-integration';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = mkdtempSync(path.join(tmpdir(), 'input-candidate-'));
  process.env.TASK_GRAPH_UPSTREAM_ROOT = path.join(root, 'upstream');
  process.env.AP_WORKSPACE_ROOT = path.join(root, 'workspaces');
  const git = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  const repository = (name: string) => {
    const directory = path.join(root, name); mkdirSync(directory); git(directory, 'init', '-b', 'main');
    git(directory, 'config', 'user.name', 'Test'); git(directory, 'config', 'user.email', 'fixture@example.test');
    writeFileSync(path.join(directory, 'identity'), name);
    writeFileSync(path.join(directory, 'value.js'), 'module.exports = 1;\n'); git(directory, 'add', '.'); git(directory, 'commit', '-m', 'base');
    return { directory, commit: git(directory, 'rev-parse', 'HEAD') };
  };
  const reader = repository('reader'), mold = repository('mold');
  const candidate = path.join(root, 'candidate'); git(reader.directory, 'worktree', 'add', '-b', 'candidate', candidate, reader.commit);
  writeFileSync(path.join(candidate, 'value.js'), 'module.exports = 2;\n'); git(candidate, 'add', '.'); git(candidate, 'commit', '-m', 'repair');
  const fixed = git(candidate, 'rev-parse', 'HEAD');
  writeFileSync(path.join(reader.directory, 'value.js'), 'preserve unrelated shared edit');
  const log = path.join(root, 'verified.log'); writeFileSync(log, 'candidate behavior passed');
  const artifacts = [{ path: log, sha256: createHash('sha256').update(readFileSync(log)).digest('hex') }];
  const parent = await prisma.task.create({ data: { name: 'input candidate' } });
  const child = await prisma.task.create({ data: { name: 'consumer', workingDirectory: mold.directory } });
  const jobSpec = (repo: typeof reader) => [{ key: 'repo', repository: repo.directory, gitRef: 'refs/heads/main', baseCommit: repo.commit, agentSelector: 'local:codex', instructions: 'fixture' }];
  const common = { acceptance: { mode: 'automatic' as const, checks: ['behavior'] } };
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'fixture://candidate', nodes: [
    { ...common, key: 'R', goal: 'producer', dependsOn: [], executions: jobSpec(reader) },
    { ...common, executionMode: 'implement', key: 'M', goal: 'consumer', dependsOn: ['R'], executions: jobSpec(mold), extraRepositories: [{ repository: reader.directory, access: 'read' }] },
    { ...common, key: 'OTHER', goal: 'other consumer', dependsOn: ['R'], executions: jobSpec(mold) },
  ] } });
  const nodes = await prisma.taskGraphNode.findMany({ where: { runId: run.id }, include: { executions: true } });
  const producer = nodes.find(n => n.key === 'R')!, consumer = nodes.find(n => n.key === 'M')!, other = nodes.find(n => n.key === 'OTHER')!;
  const job = consumer.executions[0];
  const metadata = (revision: number, commit = mold.commit) => metadataWithProgress(null, { ...initialExecutionProgress(), revision, state: 'waiting_decision',
    phase: 'implement', candidateCommit: commit, workspaceBase: mold.commit });
  const workers = require('../src/lib/task-graph/phase-worker');
  const originalObserve = workers.observeExecutionWriter;
  workers.observeExecutionWriter = async () => ({ kind: 'exited' });
  try {
    await prisma.taskGraphNode.update({ where: { id: producer.id }, data: { status: 'passed' } });
    await prisma.taskGraphExecution.update({ where: { id: producer.executions[0].id }, data: { status: 'integrated', commit: reader.commit } });
    await prisma.taskGraphNode.update({ where: { id: consumer.id }, data: { status: 'attention' } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'attention', childTaskId: child.id, claimToken: 'old', dispatchMetadata: metadata(7) } });
    const old = await prepareUpstreamInputs(job.id);
    const receipt: InputCandidateReceipt = { version: 1, executionId: job.id, requestId: 'approved-repair', claimToken: 'old', revision: 7,
      inputHash: old.manifest.hash, primaryCandidateCommit: mold.commit, repository: reader.directory, previousCommit: reader.commit,
      candidateCommit: fixed, authorization: 'fixture user approved this exact cross-repository repair', artifacts };
    for (const patch of [{ revision: 6 }, { inputHash: '0'.repeat(64) }, { primaryCandidateCommit: reader.commit }, { repository: mold.directory }, { authorization: '' }]) {
      await assert.rejects(registerInputCandidate({ ...receipt, ...patch }));
    }
    workers.observeExecutionWriter = async () => ({ kind: 'alive' });
    await assert.rejects(registerInputCandidate(receipt), /原写作者/);
    workers.observeExecutionWriter = async () => {
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadata(8) } }); return { kind: 'exited' };
    };
    await assert.rejects(registerInputCandidate(receipt), /执行身份改变/);
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadata(7) } });
    workers.observeExecutionWriter = async () => ({ kind: 'exited' });
    assert.equal(await graphReviewClaimKey(consumer.id, 'acceptance', 'same-primary'), 'same-primary');
    const registered = await Promise.all([registerInputCandidate(receipt), registerInputCandidate(receipt)]);
    assert.equal(registered[0].eventId, registered[1].eventId);
    await assert.rejects(registerInputCandidate({ ...receipt, authorization: 'different' }), /requestId/);
    await assert.rejects(registerInputCandidate({ ...receipt, requestId: 'duplicate-candidate' }), /已有待应用候选/);
    assert.deepEqual((await prepareUpstreamInputs(job.id)).manifest, old.manifest, 'Registration must not replace an existing claim pin');
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).status, 'attention', 'Registration never dispatches');
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { claimToken: 'next', dispatchMetadata: metadata(8, reader.commit) } });
    await assert.rejects(prepareUpstreamInputs(job.id), /主仓候选已改变/);
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadata(8) } });
    const [prepared, duplicate] = await Promise.all([prepareUpstreamInputs(job.id), prepareUpstreamInputs(job.id)]);
    assert.equal(prepared.manifest.hash, duplicate.manifest.hash);
    const input = prepared.manifest.inputs[0];
    const newReview = await graphReviewClaimKey(consumer.id, 'acceptance', 'same-primary');
    assert.notEqual(newReview, 'same-primary', 'New Reader input must invalidate old review even if primary commit is unchanged');
    assert.equal(await graphReviewClaimKey(consumer.id, 'architecture', 'same-primary'), newReview);
    assert.equal(input.commit, fixed, 'New attempt must consume the explicitly frozen repair, not the old upstream delivery');
    assert.deepEqual(input.quality, ['candidate_unverified']); assert.deepEqual(input.resultsDirectories, []); assert.deepEqual(input.executions, []);
    assert.deepEqual(input.replacement, { eventId: registered[0].eventId, previousCommit: reader.commit });
    assert.equal(readFileSync(path.join(input.sourcePath, 'value.js'), 'utf8'), 'module.exports = 2;\n');
    for (const taskId of [child.id, `task-graph-review-${consumer.id}`, `task-graph-architecture-${consumer.id}`]) {
      const view = await graphInputsForTask(taskId); assert.equal(view.manifests[0].hash, prepared.manifest.hash);
      assert.match(view.instructions, /candidate_unverified/);
    }
    const check = await runSandboxedGraphCheck([process.execPath, '-e', `const fs=require('fs'),a=require('assert/strict');a.equal(require(${JSON.stringify(path.join(input.sourcePath, 'value.js'))}),2);a.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(input.sourcePath, 'value.js'))},'bad'));console.log('fixed candidate consumed read-only')`], mold.directory, prepared.env, prepared.readOnlyPaths);
    assert.match(check.stdout, /consumed read-only/);
    const resource = await prepareResourceWorkspaces({ taskId: child.id, taskName: 'consumer', participants: [], orchestrationMode: 'single', workingDirectory: mold.directory,
      graphExecution: { executionId: job.id, claimToken: 'next', revision: 8 } }, await canonicalResourceDirectories([{ path: reader.directory, access: 'write' }]), [prepared.manifest]);
    assert.equal(git(resource.write[0], 'rev-parse', 'HEAD'), fixed);
    assert.match(resource.instructions, /允许主仓消费并提交验收/); assert(!resource.instructions.includes('正式交付范围另行确认'));
    assert.equal((await prepareUpstreamInputs(other.executions[0].id)).manifest.inputs[0].commit, reader.commit, 'Other consumers retain their original delivery');
    assert.equal(readFileSync(path.join(old.manifest.inputs[0].sourcePath, 'value.js'), 'utf8'), 'module.exports = 1;\n');
    assert.equal(readFileSync(path.join(reader.directory, 'value.js'), 'utf8'), 'preserve unrelated shared edit');
    assert.equal((await registerInputCandidate(receipt)).eventId, registered[0].eventId, 'Historical receipt replay survives later claims');
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { claimToken: 'later', dispatchMetadata: metadata(9, fixed) } });
    assert.equal((await prepareUpstreamInputs(job.id)).manifest.inputs[0].commit, fixed, 'Applied binding persists through primary repository edits');
    assert.equal(await graphReviewClaimKey(consumer.id, 'acceptance', 'same-primary'), newReview, 'Retry keeps the frozen candidate review identity');
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: consumer.id, kind: 'task_input_candidate_applied' } }), 1);
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', commit: mold.commit } });
    await prisma.taskGraphNode.update({ where: { id: consumer.id }, data: { status: 'verifying' } });
    const evidence = { checks: [{ name: 'behavior', passed: true, evidence: 'fixed candidate checked' }], summary: 'candidate verified' };
    await assertCandidateInputsReady(prisma, consumer.id);
    await assert.rejects(assertCandidateInputsIntegrated(prisma, consumer.id), /尚未汇合/);
    const registeredEvent = await prisma.taskGraphEvent.findUniqueOrThrow({ where: { id: registered[0].eventId } });
    assert(registeredEvent.payload && typeof registeredEvent.payload === 'object' && !Array.isArray(registeredEvent.payload));
    const originalPayload = registeredEvent.payload;
    for (const invalid of [
      { ...originalPayload, receipt: { ...receipt, executionId: other.executions[0].id } },
      { ...originalPayload, receipt: { ...receipt, repository: mold.directory } },
      { ...originalPayload, receipt: { ...receipt, candidateCommit: reader.commit } },
      { ...originalPayload, integrationRefs: [] },
      { ...originalPayload, integrationRefs: [''] },
    ]) {
      await prisma.taskGraphEvent.update({ where: { id: registeredEvent.id }, data: { payload: invalid } });
      try {
        await assert.rejects(assertCandidateInputsReady(prisma, consumer.id), /汇合来源无效/);
        await assert.rejects(assertCandidateInputsIntegrated(prisma, consumer.id), /汇合来源无效/);
      } finally {
        await prisma.taskGraphEvent.update({ where: { id: registeredEvent.id }, data: { payload: originalPayload } });
      }
    }
    await assert.rejects(submitNodeVerification({ runId: run.id, nodeKey: 'M', actorId: 'system', evidence }), /尚未汇合/);
    await assert.rejects(completeUnverifiedNode(run.id, 'M'), /尚未汇合/);
    await prisma.taskGraphNode.update({ where: { id: consumer.id }, data: { status: 'awaiting_human', acceptance: 'human', reviewerId: 'reviewer' } });
    await assert.rejects(approveHumanNode({ runId: run.id, nodeKey: 'M', reviewerId: 'reviewer', approved: true, note: 'checked' }), /尚未汇合/);
    await prisma.taskGraphNode.update({ where: { id: consumer.id }, data: { status: 'verifying', acceptance: 'automatic', reviewerId: null } });
    const failed = await submitNodeVerification({ runId: run.id, nodeKey: 'M', actorId: 'system', attempt: 'failed', evidence: { ...evidence, checks: [{ ...evidence.checks[0], passed: false }] } });
    assert.equal(failed.status, 'attention', 'Candidate defects can still be published before integration');
    await prisma.taskGraphNode.update({ where: { id: consumer.id }, data: { status: 'verifying' } });
    git(reader.directory, 'update-ref', 'refs/heads/main', fixed, reader.commit);
    await assertCandidateInputsReady(prisma, consumer.id);
    await assertCandidateInputsIntegrated(prisma, consumer.id);
    assert.equal((await submitNodeVerification({ runId: run.id, nodeKey: 'M', actorId: 'system', attempt: 'integrated', evidence })).status, 'passed');
    assert.equal(readFileSync(path.join(reader.directory, 'value.js'), 'utf8'), 'preserve unrelated shared edit');
    writeFileSync(path.join(input.sourcePath, 'value.js'), 'corrupted');
    await assert.rejects(prepareUpstreamInputs(job.id), /内容与 Git 不一致/);
    console.log('Candidate registration, stale/live/racing writer rejection, immutable old pin, next-claim consumption, reviewer identity, readonly sandbox, approved repair workspace and replay verified');
  } finally {
    workers.observeExecutionWriter = originalObserve;
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    await prisma.task.deleteMany({ where: { id: { in: [parent.id, child.id] } } });
    await prisma.$disconnect(); rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
