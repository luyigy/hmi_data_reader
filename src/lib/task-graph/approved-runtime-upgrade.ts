import type { TaskGraphExecution } from '@prisma/client';
import { prisma } from '../prisma';
import { projectCapabilityContext } from '../project-capabilities/context';
import { executionProgress } from './execution-progress';

/** Authorization to inspect a replacement for the next claim never replaces the current pin. */
export async function approvedRuntimeUpgrade(job: TaskGraphExecution, policyFile?: string) {
  const progress = executionProgress(job.dispatchMetadata);
  if (job.status !== 'attention' || !job.claimToken || !job.childTaskId || !job.worktreePath || !progress ||
      progress.phase !== 'implement' || progress.conflictRepair || !['waiting_for_user', 'waiting_decision'].includes(progress.state)) return null;
  const context = await projectCapabilityContext({ taskId: job.childTaskId, workspace: job.worktreePath, executionId: job.id, policyFile });
  if (!context) return null;
  const approval = context.approval;
  if (approval?.kind !== 'change' || approval.runtimeUpgradeRevision === undefined || approval.runtimeUpgradeRevision > progress.revision ||
      approval.originalClaim !== job.claimToken || approval.candidateCommit !== progress.candidateCommit) return null;
  const pin = await prisma.taskGraphEvent.findUnique({ where: { runId_idempotencyKey: { runId: context.job.node.runId,
    idempotencyKey: `runtime-snapshot:${job.id}:${job.claimToken}` } } });
  const payload = pin?.payload;
  if (!pin || !approval.runtimePinIds.includes(pin.id) || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const snapshot = payload.snapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot.projectPolicyHash !== approval.previousPolicyHash ||
      snapshot.executionId !== job.id || snapshot.claimToken !== job.claimToken || snapshot.sourceRepository !== job.repository) return null;
  return { approvalId: approval.id };
}
