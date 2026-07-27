import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { loadProjectsConfig } from './project-config';

export type WorkflowReviewPending = {
  key: string;
  gate: 'plan_review' | 'workflow_ready';
  reviewState?: 'review' | 'approved' | 'awaiting_revision_feedback' | 'revision_requested' | 'revision' | 'rejected';
  reviewMessageId?: string;
  reviewExpiresAt?: string;
  reviewFeedback?: string;
  revisionFeedbackMessageId?: string;
  revisionDispatched?: boolean;
};

export type WorkflowReviewDecision = 'approve' | 'reject' | 'revision' | 'revise';

export function applyWorkflowReviewDecision(args: {
  pending: WorkflowReviewPending;
  decision: WorkflowReviewDecision;
  actorOpenId?: string;
  approverOpenId: string;
  messageId?: string;
  pendingKey: string;
  reviewFeedback?: string;
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
          : args.reviewFeedback?.trim()
            ? 'revision_requested' as const
            : 'awaiting_revision_feedback' as const,
      ...(args.decision === 'revision' ? { reviewFeedback: args.reviewFeedback?.trim() ?? '' } : {}),
    },
  };
}

const wakeWorkflowReview = async (
  project: Awaited<ReturnType<typeof loadProjectsConfig>>['projects'][number],
  job: Awaited<ReturnType<typeof loadProjectsConfig>>['projects'][number]['jobs'][number],
  eventKey: string,
) => {
  const { executeScheduledJob } = await import('./runner');
  const { jobHandlers } = await import('./handlers');
  const handler = jobHandlers.get(job.type);
  if (handler) {
    await executeScheduledJob(prisma, project, job, new Date(), handler, 'workflow_review', eventKey);
  }
};

export function applyWorkflowRevisionFeedback(args: {
  pending: WorkflowReviewPending;
  actorOpenId: string;
  approverOpenId: string;
  parentMessageId: string;
  feedback: string;
}) {
  if (args.actorOpenId !== args.approverOpenId
    || args.pending.reviewState !== 'awaiting_revision_feedback'
    || args.pending.revisionFeedbackMessageId !== args.parentMessageId
    || !args.feedback.trim()) {
    return { status: 'ignored' as const, pending: args.pending };
  }
  return {
    status: 'applied' as const,
    pending: {
      ...args.pending,
      reviewState: 'revision_requested' as const,
      reviewFeedback: args.feedback.trim(),
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
  reviewFeedback?: string;
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
  if (result.status === 'applied') {
    void wakeWorkflowReview(project, job, args.pendingKey)
      .catch((error) => console.error('[WorkflowReview] failed to process review decision', error));
  }
  return { ...result, chatId: project.feishu.chat_id };
}

export async function resolveWorkflowRevisionFeedback(args: {
  chatId: string;
  actorOpenId: string;
  parentMessageId?: string;
  feedback: string;
}) {
  if (!args.parentMessageId || !args.feedback.trim()) return { status: 'ignored' as const };
  const parentMessageId = args.parentMessageId;
  const { projects } = await loadProjectsConfig();
  const project = projects.find(({ feishu }) => feishu.chat_id === args.chatId);
  const job = project?.jobs.find(({ type }) => type === 'workflow_watcher');
  if (!project || !job || project.feishu.approver_open_ids[0] !== args.actorOpenId) {
    return { status: 'ignored' as const };
  }
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
      return { status: 'ignored' as const };
    }
    const pending = (cursor as { pending?: WorkflowReviewPending }).pending;
    if (!pending) return { status: 'ignored' as const };
    const applied = applyWorkflowRevisionFeedback({
      pending,
      actorOpenId: args.actorOpenId,
      approverOpenId: project.feishu.approver_open_ids[0],
      parentMessageId,
      feedback: args.feedback,
    });
    if (applied.status !== 'applied') {
      return { status: 'ignored' as const };
    }
    await tx.scheduledJobState.update({
      where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
      data: {
        cursorJson: {
          ...(cursor as Record<string, Prisma.JsonValue>),
          pending: applied.pending,
        } as Prisma.InputJsonValue,
      },
    });
    return { status: 'applied' as const, pendingKey: pending.key };
  });
  if (result.status === 'applied') {
    void wakeWorkflowReview(project, job, `${result.pendingKey}:feedback`)
      .catch((error) => console.error('[WorkflowReview] failed to process revision feedback', error));
  }
  return result;
}
