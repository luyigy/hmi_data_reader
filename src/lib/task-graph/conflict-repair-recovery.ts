import { prisma } from '../prisma';
import { executionProgress, applyExecutionOutcome, type ExecutionFailure } from './execution-progress';
import { observeExecutionWriter } from './phase-worker';
import { withRepositoryLock } from './repository-lock';
import { approvedConflictCommits, prepareConflictRepair } from './conflict-repair';
import type { IntegrationConflict } from './integration-failure';
import { isDeepStrictEqual } from 'node:util';

function recordedConflict(detail: unknown): IntegrationConflict | null {
  if (typeof detail !== 'string') return null;
  try {
    // Legacy host records encode one JSON line followed by diagnostic lines.
    const value: unknown = JSON.parse(detail.split('\n', 1)[0]);
    if (!value || typeof value !== 'object' || !('integration' in value)) return null;
    const item = value.integration;
    if (!item || typeof item !== 'object' || !('kind' in item) || item.kind !== 'conflict' ||
        !('candidateCommit' in item) || typeof item.candidateCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(item.candidateCommit) ||
        !('integrationCommit' in item) || typeof item.integrationCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(item.integrationCommit) ||
        !('mergeHead' in item) || item.mergeHead !== null && (typeof item.mergeHead !== 'string' || !/^[a-f0-9]{40,64}$/.test(item.mergeHead)) ||
        !('paths' in item) || !Array.isArray(item.paths) || !item.paths.length || !item.paths.every((file): file is string => typeof file === 'string')) return null;
    return { kind: 'conflict', candidateCommit: item.candidateCommit, integrationCommit: item.integrationCommit, mergeHead: item.mergeHead, paths: item.paths };
  } catch { return null; }
}

/** Legacy conflict decisions use the same bounded repair path after their old writer exits. */
export async function recoverPendingConflictRepairs(runId: string) {
  const jobs = await prisma.taskGraphExecution.findMany({ where: { node: { runId }, status: 'attention', issueKind: 'integration_conflict' } });
  for (const job of jobs) {
    const progress = executionProgress(job.dispatchMetadata);
    if (!progress || progress.state !== 'waiting_decision' || progress.lastFailure?.requiresUserDecision === true || !job.claimToken) continue;
    const failure: ExecutionFailure = { ...progress.lastFailure!, code: 'integration_conflict', detail: progress.lastFailure?.detail || 'Pending merge requires a bounded repair',
      action: '平台核验原执行者退出证据及账本中的候选、合并父提交与当前集成引用；保留现场，核验后由受控合并步骤处理所列文件', owner: 'platform', requiresUserDecision: false };
    try {
      const writer = await observeExecutionWriter(job);
      if (writer.kind !== 'exited') {
        const idempotencyKey = `conflict-writer:${job.id}:${progress.revision}:${writer.kind}`;
        await prisma.taskGraphEvent.upsert({ where: { runId_idempotencyKey: { runId, idempotencyKey } }, update: {},
          create: { runId, nodeId: job.nodeId, idempotencyKey, kind: 'writer_observation', payload: writer } });
        continue;
      }
      const evidence = recordedConflict(progress.lastFailure?.detail);
      if (!evidence) throw new Error('Legacy conflict has no complete recorded merge evidence');
      if (evidence.candidateCommit !== progress.candidateCommit) throw new Error('Recorded conflict candidate changed');
      failure.detail = JSON.stringify({ integration: evidence });
      failure.affectedPaths = evidence.paths;
      const metadata = job.dispatchMetadata;
      const integrationRef = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata.integrationRef : null;
      if (typeof integrationRef !== 'string' || !progress.workspaceBase) throw new Error('Legacy conflict has no approved integration identity');
      const checkpoint = await withRepositoryLock(job.repository, async () => prepareConflictRepair({
        repoPath: job.repository, runId, jobId: job.id, baseCommit: progress.workspaceBase!, integrationRef,
        evidence, approvedCommits: await approvedConflictCommits(runId, job.repository), assertOwnership: async () => {
          const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
          if (current.status !== 'attention' || current.claimToken !== job.claimToken || executionProgress(current.dispatchMetadata)?.revision !== progress.revision) throw new Error('Conflict recovery ownership changed');
        },
      }));
      await applyExecutionOutcome({ executionId: job.id, claimToken: job.claimToken, expectedRevision: progress.revision,
        outcomeId: `conflict-recovery:${progress.revision}`, outcome: { kind: 'repair_required', conflictRepair: checkpoint,
          failure: { ...failure, action: '原批准范围内输出冲突解决文件，平台完成合并并复验', owner: 'implementer', requiresUserDecision: false } } });
    } catch (error) {
      const current = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
      if (current.status !== 'attention' || current.claimToken !== job.claimToken || executionProgress(current.dispatchMetadata)?.revision !== progress.revision) continue;
      const diagnostic = `\n${error instanceof Error ? error.message : String(error)}`;
      if (failure.detail.endsWith(diagnostic)) continue;
      failure.detail += diagnostic;
      if (isDeepStrictEqual(failure, progress.lastFailure)) continue;
      await applyExecutionOutcome({ executionId: job.id, claimToken: job.claimToken, expectedRevision: progress.revision,
        outcomeId: `conflict-decision:${progress.revision}`, outcome: { kind: 'decision_required', failure } });
    }
  }
}
