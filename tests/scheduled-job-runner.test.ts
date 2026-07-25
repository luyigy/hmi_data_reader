import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { noopTestHandler } from '../src/lib/scheduled-jobs/handlers';
import { executeScheduledJob, matchesCron } from '../src/lib/scheduled-jobs/runner';
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

  await executeScheduledJob(prisma, project, job('failure', { fail: true }), scheduledFor, noopTestHandler);
  await executeScheduledJob(prisma, project, job('timeout', { delay_ms: 100, timeout_ms: 10 }), scheduledFor, noopTestHandler);
  const statuses = await prisma.scheduledJobRun.findMany({
    where: { projectId: project.id },
    select: { jobId: true, status: true },
  });
  assert.deepEqual(Object.fromEntries(statuses.map(({ jobId, status }) => [jobId, status])), {
    success: 'succeeded',
    failure: 'failed',
    timeout: 'timed_out',
  });
  console.log('scheduled job runner checks passed');
}

const cleanup = () => prisma.$transaction([
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
