import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { reconcileScheduledJobRunner } from '../src/lib/scheduled-jobs/reconciliation';

const suffix = `${process.pid}-${Date.now()}`;
const projectId = `reconcile-${suffix}`;
const requesterPrefix = `reconcile-${suffix}`;
const old = new Date(Date.now() - 60_000);
const bootStartedAt = new Date();
const future = new Date(Date.now() + 60_000);

async function createTaskRun(name: string, childPid: number) {
  const task = await prisma.task.create({
    data: { name: `${requesterPrefix}-${name}`, status: 'running', startedAt: old },
  });
  const run = await prisma.taskRun.create({
    data: { taskId: task.id, status: 'running', startedAt: old, lastActivityAt: old },
  });
  await prisma.taskRunParticipant.create({
    data: {
      taskRunId: run.id,
      executionBackend: 'platform_local',
      gatewayNameSnapshot: 'Local',
      harnessType: 'node',
      role: 'custom',
      status: 'running',
      startedAt: old,
      lastActivityAt: old,
      controlMetadata: JSON.stringify({ childPid }),
    },
  });
  return { task, run };
}

async function main() {
  await prisma.scheduledJobRun.createMany({
    data: [
      {
        projectId,
        jobId: 'old',
        trigger: 'schedule',
        mode: 'shadow',
        status: 'running',
        scheduledFor: old,
        startedAt: old,
        idempotencyKey: `${projectId}:old`,
      },
      {
        projectId,
        jobId: 'current',
        trigger: 'schedule',
        mode: 'shadow',
        status: 'running',
        scheduledFor: bootStartedAt,
        startedAt: bootStartedAt,
        idempotencyKey: `${projectId}:current`,
      },
    ],
  });
  await prisma.scheduledJobRequest.createMany({
    data: [
      { projectId, jobId: 'old', status: 'processing', requestedAt: old, claimedAt: old },
      {
        projectId,
        jobId: 'current',
        status: 'processing',
        requestedAt: bootStartedAt,
        claimedAt: bootStartedAt,
      },
      { projectId, jobId: 'pending', status: 'pending', requestedAt: old },
    ],
  });
  await prisma.feishuAdminApproval.createMany({
    data: [
      {
        kind: 'full_access',
        requesterOpenId: `${requesterPrefix}-expired`,
        requesterChatId: 'test',
        expiresAt: old,
      },
      {
        kind: 'full_access',
        requesterOpenId: `${requesterPrefix}-future`,
        requesterChatId: 'test',
        expiresAt: future,
      },
      {
        kind: 'full_access',
        requesterOpenId: `${requesterPrefix}-processing`,
        requesterChatId: 'test',
        status: 'processing',
        expiresAt: old,
      },
    ],
  });
  const stale = await createTaskRun('stale', 2_147_483_647);
  const alive = await createTaskRun('alive', process.pid);

  const first = await reconcileScheduledJobRunner(prisma, bootStartedAt);
  assert.equal(first.scheduledJobRuns, 1);
  assert.equal(first.scheduledJobRequests, 1);
  assert(first.reconciledTaskRuns >= 1);
  assert.equal(first.expiredApprovals, 1);
  assert.deepEqual(await reconcileScheduledJobRunner(prisma, bootStartedAt), {
    scheduledJobRuns: 0,
    scheduledJobRequests: 0,
    reconciledTaskRuns: 0,
    expiredApprovals: 0,
  });

  const runs = await prisma.scheduledJobRun.findMany({
    where: { projectId },
    select: { jobId: true, status: true, error: true, finishedAt: true },
  });
  assert.deepEqual(
    Object.fromEntries(runs.map(({ jobId, ...run }) => [jobId, run])),
    {
      old: { status: 'failed', error: 'process_restart', finishedAt: runs.find(({ jobId }) => jobId === 'old')?.finishedAt },
      current: { status: 'running', error: null, finishedAt: null },
    },
  );
  assert((await prisma.scheduledJobRequest.findFirstOrThrow({
    where: { projectId, jobId: 'old' },
  })).status === 'failed');
  assert((await prisma.scheduledJobRequest.findFirstOrThrow({
    where: { projectId, jobId: 'pending' },
  })).status === 'pending');
  assert.equal((await prisma.taskRun.findUniqueOrThrow({ where: { id: stale.run.id } })).status, 'failed');
  assert.equal((await prisma.taskRun.findUniqueOrThrow({ where: { id: alive.run.id } })).status, 'running');

  const approvals = await prisma.feishuAdminApproval.findMany({
    where: { requesterOpenId: { startsWith: requesterPrefix } },
    select: { requesterOpenId: true, status: true },
  });
  assert.deepEqual(Object.fromEntries(approvals.map(({ requesterOpenId, status }) => [
    requesterOpenId.slice(requesterPrefix.length + 1),
    status,
  ])), { expired: 'expired', future: 'pending', processing: 'processing' });
  console.log('scheduled job reconciliation checks passed');
}

const cleanup = () => prisma.$transaction([
  prisma.feishuAdminApproval.deleteMany({ where: { requesterOpenId: { startsWith: requesterPrefix } } }),
  prisma.scheduledJobRequest.deleteMany({ where: { projectId } }),
  prisma.scheduledJobRun.deleteMany({ where: { projectId } }),
  prisma.task.deleteMany({ where: { name: { startsWith: requesterPrefix } } }),
]);

main()
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
