import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { noopTestHandler } from '../src/lib/scheduled-jobs/handlers';
import {
  executeScheduledJob,
  effectiveJobSchedule,
  matchesCron,
  runRequestedJobs,
  stopScheduledJob,
  waitForScheduledJobStop,
} from '../src/lib/scheduled-jobs/runner';
import type { JobConfig, ProjectConfig } from '../src/lib/scheduled-jobs/project-config';

const suffix = `${process.pid}-${Date.now()}`;
const project: ProjectConfig = {
  id: `runner-test-${suffix}`,
  name: 'Runner test',
  path: process.cwd(),
  ref: 'refs/heads/test',
  feishu: { chat_id: `test-${suffix}`, approver_open_ids: [] },
  jobs: [],
};
const job = (id: string, config: Record<string, unknown> = {}): JobConfig => ({
  id,
  type: 'noop_test',
  schedule: '* * * * *',
  enabled: true,
  mode: 'shadow',
  config,
});

async function main() {
  assert(matchesCron('*/10 * * * *', new Date('2026-07-25T12:20:00Z')));
  assert(!matchesCron('*/10 * * * *', new Date('2026-07-25T12:21:00Z')));
  assert.equal(effectiveJobSchedule(job('schedule')), '* * * * *');
  assert.equal(effectiveJobSchedule(job('schedule'), { scheduleOverride: '*/5 * * * *' }), '*/5 * * * *');

  const scheduledFor = new Date('2026-07-25T12:20:00Z');
  const successJob = job('success', { delay_ms: 100 });
  const [first, duplicate] = await Promise.all([
    executeScheduledJob(prisma, project, successJob, scheduledFor, noopTestHandler),
    executeScheduledJob(prisma, project, successJob, scheduledFor, noopTestHandler),
  ]);
  assert.equal(Number(first) + Number(duplicate), 1);

  const successState = await prisma.scheduledJobState.findUniqueOrThrow({
    where: { projectId_jobId: { projectId: project.id, jobId: successJob.id } },
  });
  assert.deepEqual(successState.cursorJson, { runs: 1 });

  const eventJob = job('event');
  const [event, duplicateEvent] = await Promise.all([
    executeScheduledJob(prisma, project, eventJob, new Date(), noopTestHandler, 'task_run_completed', 'run-1'),
    executeScheduledJob(prisma, project, eventJob, new Date(), noopTestHandler, 'task_run_completed', 'run-1'),
  ]);
  assert.equal(Number(event) + Number(duplicateEvent), 1);

  await executeScheduledJob(prisma, project, job('failure', { fail: true }), scheduledFor, noopTestHandler);
  await executeScheduledJob(prisma, project, job('timeout', { delay_ms: 100, timeout_ms: 10 }), scheduledFor, noopTestHandler);
  const feishuCalls: Array<{ body?: string }> = [];
  process.env.FEISHU_APP_ID = 'test-app';
  process.env.FEISHU_APP_SECRET = 'test-secret';
  global.fetch = (async (_input, init) => {
    feishuCalls.push({ body: init?.body?.toString() });
    return new Response(JSON.stringify(feishuCalls.length === 1
      ? { code: 0, tenant_access_token: 'token', expire: 3600 }
      : { code: 0 }));
  }) as typeof fetch;
  const activeFailureJob = { ...job('active-failure', { fail: true }), mode: 'active' as const };
  assert.equal(
    await executeScheduledJob(prisma, project, activeFailureJob, scheduledFor, noopTestHandler),
    false,
  );
  const failureNotice = JSON.parse(feishuCalls[1].body!).content;
  assert.match(failureNotice, /定时任务执行失败：Runner test \/ active-failure/);
  assert.match(failureNotice, /原因：noop test failure/);
  assert.match(failureNotice, /影响：本次动作未完成.*其他项目继续运行/);
  assert.match(failureNotice, /下一步：修复上述运行故障后重新运行/);
  assert.equal(
    await executeScheduledJob(
      prisma,
      project,
      activeFailureJob,
      new Date(scheduledFor.getTime() + 60_000),
      noopTestHandler,
    ),
    false,
  );
  assert.equal(feishuCalls.length, 2, 'unchanged consecutive failures must not resend notifications');
  const stoppedJob = job('stopped', { delay_ms: 10_000 });
  const unaffectedJob = job('unaffected', { delay_ms: 20 });
  const stoppedRun = executeScheduledJob(prisma, project, stoppedJob, new Date(), noopTestHandler);
  const unaffectedRun = executeScheduledJob(prisma, project, unaffectedJob, new Date(), noopTestHandler);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(await stopScheduledJob(prisma, project.id, stoppedJob.id));
  await waitForScheduledJobStop(prisma, project.id, stoppedJob.id);
  assert.equal(await stoppedRun, false);
  assert(!await stopScheduledJob(prisma, project.id, stoppedJob.id), 'repeated stop must report idle');
  assert(!await stopScheduledJob(prisma, project.id, 'missing'));
  assert.equal(await unaffectedRun, true);
  const remoteJob = job('remote-stopped', { delay_ms: 10_000 });
  const remoteRun = executeScheduledJob(prisma, project, remoteJob, new Date(), noopTestHandler);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await prisma.scheduledJobRun.updateMany({
    where: { projectId: project.id, jobId: remoteJob.id, status: 'running' },
    data: { error: 'job cancellation requested by operator' },
  });
  assert.equal(await remoteRun, false, 'runner must observe cross-process stop requests');
  const statuses = await prisma.scheduledJobRun.findMany({
    where: { projectId: project.id },
    select: { jobId: true, status: true, error: true },
  });
  assert.deepEqual(Object.fromEntries(statuses.map(({ jobId, status }) => [jobId, status])), {
    success: 'succeeded',
    event: 'succeeded',
    failure: 'failed',
    'active-failure': 'failed',
    timeout: 'timed_out',
    stopped: 'failed',
    unaffected: 'succeeded',
    'remote-stopped': 'failed',
  });
  assert.equal(statuses.find(({ jobId }) => jobId === 'stopped')?.error, 'job cancelled by operator');
  assert.equal(statuses.find(({ jobId }) => jobId === 'remote-stopped')?.error, 'job cancelled by operator');

  const disabledJob = job('disabled');
  await prisma.scheduledJobState.create({
    data: { projectId: project.id, jobId: disabledJob.id, enabledOverride: false },
  });
  assert.equal(
    await executeScheduledJob(prisma, project, disabledJob, new Date(), noopTestHandler),
    false,
  );
  const disabledRun = await prisma.scheduledJobRun.findFirstOrThrow({
    where: { projectId: project.id, jobId: disabledJob.id },
  });
  assert.equal(disabledRun.status, 'skipped');
  assert.equal(disabledRun.summary, 'job disabled');

  const requestedJob = job('requested', { delay_ms: 10_000 });
  project.jobs.push(requestedJob);
  const request = await prisma.scheduledJobRequest.create({
    data: { projectId: project.id, jobId: requestedJob.id },
  });
  await runRequestedJobs(prisma, { projects: [project] });
  const requestedRun = await (async () => {
    for (;;) {
      const run = await prisma.scheduledJobRun.findUnique({
        where: { idempotencyKey: `manual:${project.id}:${requestedJob.id}:${request.id}` },
      });
      if (run) return run;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  assert.equal(requestedRun.status, 'running');
  assert(await stopScheduledJob(prisma, project.id, requestedJob.id));
  await waitForScheduledJobStop(prisma, project.id, requestedJob.id);
  while ((await prisma.scheduledJobRequest.findUniqueOrThrow({ where: { id: request.id } })).status === 'processing') {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  console.log('scheduled job runner checks passed');
}

const cleanup = () => prisma.$transaction([
  prisma.scheduledJobRequest.deleteMany({ where: { projectId: project.id } }),
  prisma.scheduledJobRun.deleteMany({ where: { projectId: project.id } }),
  prisma.scheduledJobState.deleteMany({ where: { projectId: project.id } }),
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
