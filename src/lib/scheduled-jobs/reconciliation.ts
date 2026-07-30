import type { PrismaClient } from '@prisma/client';

const processRestartError = 'process_restart';

export async function reconcileScheduledJobRunner(db: PrismaClient, bootStartedAt?: Date) {
  const now = new Date();
  let scheduledJobRuns = 0;
  let scheduledJobRequests = 0;

  if (bootStartedAt) {
    const [runs, requests] = await db.$transaction([
      db.scheduledJobRun.updateMany({
        where: { status: 'running', startedAt: { lt: bootStartedAt } },
        data: { status: 'failed', finishedAt: now, error: processRestartError },
      }),
      db.scheduledJobRequest.updateMany({
        where: { status: 'processing', claimedAt: { lt: bootStartedAt } },
        data: { status: 'failed', finishedAt: now, error: processRestartError },
      }),
    ]);
    scheduledJobRuns = runs.count;
    scheduledJobRequests = requests.count;
  }

  const activeTasks = await db.taskRun.findMany({
    where: { status: { in: ['running', 'waiting_for_input'] } },
    distinct: ['taskId'],
    select: { taskId: true },
  });
  const { reconcileTaskRunLiveness } = await import('../acpx/liveness');
  const reconciledTaskRuns = (await Promise.all(
    activeTasks.map(({ taskId }) => reconcileTaskRunLiveness(taskId)),
  )).filter(Boolean).length;

  const expiredApprovals = await db.feishuAdminApproval.updateMany({
    where: { status: 'pending', expiresAt: { lte: now } },
    data: { status: 'expired' },
  });

  return {
    scheduledJobRuns,
    scheduledJobRequests,
    reconciledTaskRuns,
    expiredApprovals: expiredApprovals.count,
  };
}
