import { publishAgentCommit } from './agent-commit';
import { assertAcceptanceModels } from './acceptance-models';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { assertRoomResultAuthority } from './room-result-authority';
import { recordTaskRunResult } from './task-run-result';
import { lockWriterAdmission, assertWorkspaceWriterAvailable } from './writer-admission';
import { graphRunCanStartTx } from './run-control';
import { graphGit } from './git-command';
import { withRepositoryLock } from './repository-lock';
import { ensureIntegrationRef, integrateJobWorktree } from './worktree';
import { applyExecutionOutcomeTx, executionProgress } from './execution-progress';
import { markNodeIntegrationsReadyTx, submitNodeVerificationTx, releaseReadyNodes, refreshTaskGraphRunStatus } from './store';
import { effectiveArchitectureReview, type GraphDefinition } from './domain';
import { validAcceptanceReceipt } from './acceptance-evidence';

async function finish(tx: Prisma.TransactionClient, taskRunId: string) {
  const turn = await tx.taskRun.findUniqueOrThrow({ where: { id: taskRunId } });
  await tx.taskRun.update({ where: { id: taskRunId }, data: { controlMetadata: JSON.stringify({
    ...JSON.parse(turn.controlMetadata || '{}'), graphRoomResultPending: false,
  }) } });
}

/** A completed room turn publishes through the same integration/outcome/verification operations. */
export async function publishRoomResult(taskRunId: string) {
  const receipt = await recordTaskRunResult(taskRunId);
  if (!receipt || receipt.binding.source !== 'room') return;
  const { binding, result } = receipt;
  if (result.kind !== 'review' && !(result.kind === 'implementation' && result.result.status === 'delivered')) return;
  const publicationKey = `room-result-published:${taskRunId}`;
  const publish = () => prisma.$transaction(async tx => {
    await lockWriterAdmission(tx);
    if (!await graphRunCanStartTx(tx, binding.runId)) return false;
    await tx.$queryRaw`SELECT id FROM "TaskGraphNode" WHERE id = ${binding.nodeId} FOR UPDATE`;
    const previous = await tx.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: binding.runId, idempotencyKey: publicationKey } } });
    if (previous) { await finish(tx, taskRunId); return true; }
    const { node, completion } = await assertRoomResultAuthority(tx, taskRunId, binding.nodeId);
    await assertWorkspaceWriterAvailable(tx, { nodeId: node.id, taskId: binding.taskId, resultTaskRunId: taskRunId });
    const definition = node.run.snapshot as unknown as GraphDefinition;
    const planned = definition.nodes.find(item => item.key === node.key)!;
    for (const source of completion.sources) {
      if (await graphGit(source.directory, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Final source changed after the completed TaskRun');
      const head = await graphGit(source.directory, 'rev-parse', 'HEAD');
      if (head === source.commit) continue;
      const job = node.executions.find(item => item.id === source.executionId)!;
      if (result.kind !== 'implementation' || await graphGit(source.directory, 'rev-parse', 'HEAD^{tree}') !== source.tree) throw new Error('Final source changed after the completed TaskRun');
      const integration = await ensureIntegrationRef({ repoPath: job.repository, runId: node.runId, baseRef: job.gitRef, baseCommit: job.baseCommit });
      // Git can finish before the result transaction commits. Only recover an already integrated descendant with identical tested source.
      await graphGit(job.repository, 'merge-base', '--is-ancestor', source.commit, head);
      await graphGit(job.repository, 'merge-base', '--is-ancestor', head, integration.commit);
    }
    if (result.kind === 'implementation' && result.result.status === 'delivered') {
      const job = node.executions.find(item => item.id === binding.executionIds[0]);
      const source = completion.sources[0];
      if (!job || binding.executionIds.length !== 1 || source.directory !== job.worktreePath) throw new Error('Implementation result does not own the registered worktree');
      const integration = await ensureIntegrationRef({ repoPath: job.repository, runId: node.runId, baseRef: job.gitRef, baseCommit: job.baseCommit });
      const autonomous = definition.deliveryContract === 'agent_commit_v1';
      const integrated = autonomous ? await publishAgentCommit({ job, taskRunId, commit: result.result.commit!,
        integrationRef: integration.ref, expectedCommit: integration.commit }, tx) : await integrateJobWorktree({ repoPath: job.repository, runId: node.runId, jobId: job.id,
        integrationRef: integration.ref, expectedIntegrationCommit: integration.commit, baseCommit: executionProgress(job.dispatchMetadata)?.workspaceBase || job.baseCommit,
        verify: async directory => {
          if (await graphGit(directory, 'rev-parse', 'HEAD^{tree}') !== source.tree) throw new Error('Integration changed tested source; retest and submit the new version');
        },
      });
      await applyExecutionOutcomeTx(tx, { executionId: job.id, claimToken: job.claimToken || '', expectedRevision: executionProgress(job.dispatchMetadata)?.revision || 0,
        roomTaskRunId: taskRunId, outcomeId: `room:${taskRunId}`, outcome: { kind: 'integrated', commit: integrated.commit,
          evidence: { checks: [], implementation: result.result, taskRunId, integratedCommit: integrated.commit,
            finalSource: source, ticketInputs: binding.inputs.map(input => input.executionId === job.id ? { ...input, commit: integrated.commit } : input) } as unknown as Prisma.InputJsonValue } });
      await markNodeIntegrationsReadyTx(tx, node.runId, node.key);
    } else if (result.kind === 'review') {
      for (const job of node.executions) {
        if (job.status === 'integrated') continue;
        const progress = executionProgress(job.dispatchMetadata);
        const integrated = job.commit && await tx.taskGraphEvent.findFirst({ where: { nodeId: node.id, kind: 'execution_integrated', OR: [
          { idempotencyKey: `execution:${node.key}:${job.key}:integrated:${job.commit}` },
          { AND: [{ payload: { path: ['executionId'], equals: job.id } }, { payload: { path: ['commit'], equals: job.commit } }] },
        ] } });
        if (job.status !== 'attention' || !integrated || progress?.candidateCommit !== job.commit || !['architecture', 'acceptance'].includes(progress.phase)) throw new Error('Review requires a proven integrated candidate');
        // Restore the publication state, preserving exhausted counters and the failure ledger.
        await tx.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated' } });
        job.status = 'integrated';
      }
      if (node.executions.some(job => job.status !== 'integrated' || !job.commit) ||
          completion.sources.some(source => binding.inputs.find(input => input.executionId === source.executionId)?.commit !== source.commit)) throw new Error('Review result does not match the integrated candidate');
      const decision = result.decision;
      const commits = Array.from(new Map(node.executions.map(job => [job.repository, { repository: job.repository, commit: job.commit! }])).values());
      if (binding.marker === 'TASK_GRAPH_ARCH_REVIEW') {
        const policy = effectiveArchitectureReview(definition, planned);
        if (!policy) throw new Error('Architecture review is not configured');
        await tx.taskGraphEvent.create({ data: { runId: node.runId, nodeId: node.id, idempotencyKey: `room-architecture:${taskRunId}`,
          kind: decision.approved ? 'architecture_passed' : 'architecture_failed', payload: { ...decision, reviewerId: policy.reviewerId,
            taskRunId, inputs: binding.inputs, commits } as unknown as Prisma.InputJsonValue } });
        await tx.taskGraphNode.update({ where: { id: node.id }, data: { status: decision.approved ? 'verifying' : 'attention' } });
      } else {
        await assertAcceptanceModels(planned);
        const verification = validAcceptanceReceipt(result.verification, planned, binding.inputs, commits, decision.approved) ? result.verification : undefined;
        await submitNodeVerificationTx(tx, { runId: node.runId, nodeKey: node.key, actorId: planned.acceptance.reviewerId!, roomTaskRunId: taskRunId,
          review: { phase: 'acceptance', claimKey: `room-result:${taskRunId}`, taskRunId, outcome: 'classified',
            ...(!decision.approved && decision.failureKind !== 'in_scope_defect' ? { decision: { code: decision.failureKind, detail: decision.note } } : {}) },
          evidence: { inputs: binding.inputs, summary: decision.note, ...(verification ? { reviewReceipt: verification } : {}),
            checks: planned.acceptance.checks.map(name => ({ name, passed: decision.approved, evidence: `TaskRun ${taskRunId}: ${decision.note}` })) } });
      }
    }
    await tx.taskGraphEvent.create({ data: { runId: binding.runId, nodeId: binding.nodeId, kind: 'room_result_published', idempotencyKey: publicationKey,
      payload: { taskRunId, resultEventId: receipt.eventId, sources: completion.sources } as unknown as Prisma.InputJsonValue } });
    await finish(tx, taskRunId);
    return true;
  }, { timeout: 120000 });
  try {
    if (result.kind === 'implementation') {
      const job = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: binding.executionIds[0] } });
      if (!await withRepositoryLock(job.repository, publish)) return { published: false, note: '路线已暂停；正式结果保留待恢复后发布' };
    } else if (!await publish()) return { published: false, note: '路线已暂停；正式结果保留待恢复后发布' };
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error);
    await prisma.$transaction(async tx => {
      await tx.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId: binding.runId, idempotencyKey: `room-result-rejected:${taskRunId}` } },
        update: {}, create: { runId: binding.runId, nodeId: binding.nodeId, kind: 'room_result_rejected', idempotencyKey: `room-result-rejected:${taskRunId}`, payload: { taskRunId, note } } });
      await finish(tx, taskRunId);
    });
    return { published: false, note };
  }
  await releaseReadyNodes(binding.runId);
  await refreshTaskGraphRunStatus(binding.runId);
  return { published: true };
}

/** Recover a crash after native completion without starting another model turn. */
export async function recoverRoomResults() {
  const turns = await prisma.taskRun.findMany({ where: { status: 'completed', controlMetadata: { contains: '"graphRoomResultPending":true' } }, orderBy: { createdAt: 'asc' }, take: 20 });
  for (const turn of turns) await publishRoomResult(turn.id);
}
