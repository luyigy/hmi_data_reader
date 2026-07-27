import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { noopTestHandler } from '../src/lib/scheduled-jobs/handlers';
import {
  executeScheduledJob,
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
    timeout: 'timed_out',
    stopped: 'failed',
    unaffected: 'succeeded',
    'remote-stopped': 'failed',
  });
  assert.equal(statuses.find(({ jobId }) => jobId === 'stopped')?.error, 'job cancelled by operator');
  assert.equal(statuses.find(({ jobId }) => jobId === 'remote-stopped')?.error, 'job cancelled by operator');

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
