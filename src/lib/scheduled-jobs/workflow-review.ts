import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { loadProjectsConfig } from './project-config';

export type WorkflowReviewPending = {
  key: string;
  gate: 'plan_review' | 'workflow_ready';
  reviewState?: 'review' | 'approved' | 'revision' | 'rejected';
  reviewMessageId?: string;
  reviewExpiresAt?: string;
};

export type WorkflowReviewDecision = 'approve' | 'reject' | 'revision' | 'revise';

export function applyWorkflowReviewDecision(args: {
  pending: WorkflowReviewPending;
  decision: WorkflowReviewDecision;
  actorOpenId?: string;
  approverOpenId: string;
  messageId?: string;
  pendingKey: string;
  now?: Date;
}) {
  const { pending } = args;
  if (args.actorOpenId !== args.approverOpenId) return { status: 'forbidden' as const, pending };
  if (pending.gate !== 'plan_review'
    || pending.key !== args.pendingKey
    || !pending.reviewMessageId
    || pending.reviewMessageId !== args.messageId) return { status: 'stale' as const, pending };
  if (!pending.reviewExpiresAt || (args.now ?? new Date()) >= new Date(pending.reviewExpiresAt)) {
    return { status: 'expired' as const, pending };
  }
  if (pending.reviewState !== 'review') return { status: 'duplicate' as const, pending };
  if (args.decision === 'revise') return { status: 'prompt' as const, pending };
  return {
    status: 'applied' as const,
    pending: {
      ...pending,
      reviewState: args.decision === 'approve'
        ? 'approved' as const
        : args.decision === 'reject'
          ? 'rejected' as const
          : 'revision' as const,
    },
  };
}

export async function resolveWorkflowReviewCardAction(args: {
  projectId: string;
  jobId: string;
  pendingKey: string;
  decision: WorkflowReviewDecision;
  actorOpenId?: string;
  messageId?: string;
}) {
  const { projects } = await loadProjectsConfig();
  const project = projects.find(({ id }) => id === args.projectId);
  const job = project?.jobs.find(({ id }) => id === args.jobId);
  if (!project || !job || job.type !== 'workflow_watcher') return { status: 'stale' as const };
  const approverOpenId = project.feishu.approver_open_ids[0];
  if (!approverOpenId) return { status: 'forbidden' as const };

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${`${project.id}:${job.id}`}, 0))::text
    `;
    const state = await tx.scheduledJobState.findUnique({
      where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
      select: { cursorJson: true },
    });
    const cursor = state?.cursorJson;
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !('pending' in cursor)) {
      return { status: 'stale' as const };
    }
    const pending = (cursor as { pending?: WorkflowReviewPending }).pending;
    if (!pending) return { status: 'stale' as const };
    const result = applyWorkflowReviewDecision({ ...args, pending, approverOpenId });
    if (result.status === 'applied') {
      await tx.scheduledJobState.update({
        where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
        data: {
          cursorJson: {
            ...(cursor as Record<string, Prisma.JsonValue>),
            pending: result.pending,
          } as Prisma.InputJsonValue,
        },
      });
    }
    return result;
  });
  if (result.status === 'applied' && args.decision === 'approve') {
    void import('./runner').then(async ({ executeScheduledJob }) => {
      const { jobHandlers } = await import('./handlers');
      const handler = jobHandlers.get(job.type);
      if (handler) {
        await executeScheduledJob(
          prisma, project, job, new Date(), handler, 'workflow_review', args.pendingKey,
        );
      }
    }).catch((error) => console.error('[WorkflowReview] failed to start approved workflow', error));
  }
  return result;
}
