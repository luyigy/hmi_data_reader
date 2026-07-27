import { Prisma, PrismaClient } from '@prisma/client';
import { jobHandlers, type JobHandler } from './handlers';
import {
  findProjectByChatId,
  loadProjectsConfig,
  type JobConfig,
  type JobMode,
  type ProjectConfig,
  type ProjectsConfig,
} from './project-config';

const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;

const matchesField = (source: string, value: number, [minimum, maximum]: readonly [number, number]) =>
  source.split(',').some((part) => {
    const [span, stepSource] = part.split('/');
    const step = stepSource ? Number(stepSource) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    const [start, end] = span === '*' || span === '?'
      ? [minimum, maximum]
      : span.includes('-')
        ? span.split('-').map(Number)
        : [Number(span), Number(span)];
    return Number.isInteger(start) && Number.isInteger(end)
      && start >= minimum && end <= maximum && start <= value && value <= end
      && (value - start) % step === 0;
  });

export const matchesCron = (schedule: string, date: Date) => {
  const fields = schedule.trim().split(/\s+/);
  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ];
  return fields.every((field, index) => matchesField(field, values[index], ranges[index]));
};

export const effectiveJobSchedule = (job: JobConfig, state?: { scheduleOverride?: string | null } | null) =>
  state?.scheduleOverride ?? job.schedule;

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const runningJobs = new Map<string, AbortController>();
const runningJobKey = (projectId: string, jobId: string) => `${projectId}:${jobId}`;
const stopRequest = 'job cancellation requested by operator';

export const stopScheduledJob = async (db: PrismaClient, projectId: string, jobId: string) => {
  const key = runningJobKey(projectId, jobId);
  const controller = runningJobs.get(key);
  if (controller) {
    runningJobs.delete(key);
    controller.abort(new Error('job cancelled by operator'));
  }
  const requested = await db.scheduledJobRun.updateMany({
    where: { projectId, jobId, status: 'running' },
    data: { error: stopRequest },
  });
  return Boolean(controller || requested.count);
};

export const waitForScheduledJobStop = async (
  db: PrismaClient,
  projectId: string,
  jobId: string,
  timeoutMs = 5_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (await db.scheduledJobRun.count({ where: { projectId, jobId, status: 'running' } })) {
    if (Date.now() >= deadline) throw new Error(`${jobId} 停止超时`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const withTimeout = async <T>(
  milliseconds: number,
  controller: AbortController,
  handler: (signal: AbortSignal) => Promise<T>,
) => {
  let rejectTimeout: (reason: Error) => void = () => undefined;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    const error = new Error(`job timed out after ${milliseconds}ms`);
    controller.abort(error);
    rejectTimeout(error);
  }, milliseconds);
  try {
    return await Promise.race([handler(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

export async function executeScheduledJob(
  db: PrismaClient,
  project: ProjectConfig,
  job: JobConfig,
  scheduledFor: Date,
  handler: JobHandler,
  trigger = 'schedule',
  eventKey = scheduledFor.toISOString(),
) {
  const idempotencyKey = `${trigger}:${project.id}:${job.id}:${eventKey}`;
  const startedAt = new Date();
  const state = await db.scheduledJobState.findUnique({
    where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
  });
  const mode = (state?.modeOverride ?? job.mode) as JobMode;

  try {
    await db.scheduledJobRun.create({
      data: {
        projectId: project.id,
        jobId: job.id,
        trigger,
        mode,
        status: 'running',
        scheduledFor,
        startedAt,
        idempotencyKey,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
    throw error;
  }

  const configuredTimeout = Number(job.config.timeout_ms ?? 60_000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 60_000;
  let status = 'succeeded';
  let summary: string | undefined;
  let failure: string | undefined;

  try {
    const result = await db.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${`${project.id}:${job.id}`}, 0)) AS locked
      `;
      if (!locked) return null;

      const lockedState = await tx.scheduledJobState.upsert({
        where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
        create: { projectId: project.id, jobId: job.id, lastScheduledAt: scheduledFor, lastStartedAt: startedAt },
        update: { lastScheduledAt: scheduledFor, lastStartedAt: startedAt },
      });
      const key = runningJobKey(project.id, job.id);
      const controller = new AbortController();
      runningJobs.set(key, controller);
      let checkingStop = false;
      const stopPoll = setInterval(() => {
        if (checkingStop || controller.signal.aborted) return;
        checkingStop = true;
        void db.scheduledJobRun.findUnique({
          where: { idempotencyKey },
          select: { error: true },
        }).then((run) => {
          if (run?.error === stopRequest) controller.abort(new Error('job cancelled by operator'));
        }).catch(() => undefined).finally(() => {
          checkingStop = false;
        });
      }, 100);
      let result;
      try {
        result = await withTimeout(timeoutMs, controller, (signal) => handler({
          project,
          job,
          mode,
          cursor: lockedState.cursorJson,
          signal,
        }));
      } finally {
        clearInterval(stopPoll);
        if (runningJobs.get(key) === controller) runningJobs.delete(key);
      }
      if (result.cursor !== undefined) {
        await tx.scheduledJobState.update({
          where: { id: lockedState.id },
          data: { cursorJson: result.cursor as Prisma.InputJsonValue },
        });
      }
      return result;
    }, { maxWait: 5_000, timeout: timeoutMs + 5_000 });

    if (!result) {
      status = 'skipped';
      summary = 'job already running';
    } else {
      summary = result.summary;
    }
  } catch (error) {
    failure = errorText(error);
    status = failure.includes('timed out after') ? 'timed_out' : 'failed';
  }

  const finishedAt = new Date();
  if (status === 'skipped') {
    await db.scheduledJobRun.update({
      where: { idempotencyKey },
      data: { status, summary, finishedAt },
    });
    return false;
  }

  await db.$transaction([
    db.scheduledJobRun.update({
      where: { idempotencyKey },
      data: { status, summary, error: failure, finishedAt },
    }),
    db.scheduledJobState.upsert({
      where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
      create: {
        projectId: project.id,
        jobId: job.id,
        lastScheduledAt: scheduledFor,
        lastStartedAt: startedAt,
        lastFinishedAt: finishedAt,
        lastSuccessAt: status === 'succeeded' ? finishedAt : undefined,
        lastError: failure,
      },
      update: {
        lastScheduledAt: scheduledFor,
        lastStartedAt: startedAt,
        lastFinishedAt: finishedAt,
        lastSuccessAt: status === 'succeeded' ? finishedAt : undefined,
        lastError: failure ?? null,
      },
    }),
  ]);
  return status === 'succeeded';
}

export async function wakeWorkflowWatcherForTaskRun(
  db: PrismaClient,
  taskId: string,
  taskRunId: string,
) {
  const binding = await db.feishuConversationBinding.findFirst({
    where: { liveRoom: { sourceTaskId: taskId } },
    orderBy: { updatedAt: 'desc' },
    select: { chatId: true },
  });
  if (!binding) return false;

  const config = await loadProjectsConfig();
  const project = findProjectByChatId(config, binding.chatId);
  const job = project?.jobs.find((candidate) => candidate.type === 'workflow_watcher');
  const handler = jobHandlers.get('workflow_watcher');
  if (!project || !job || !handler) return false;

  const state = await db.scheduledJobState.findUnique({
    where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
    select: { enabledOverride: true },
  });
  if (!(state?.enabledOverride ?? job.enabled)) return false;

  return executeScheduledJob(db, project, job, new Date(), handler, 'task_run_completed', taskRunId);
}

export async function runDueJobs(db: PrismaClient, now = new Date()) {
  const scheduledFor = new Date(now);
  scheduledFor.setSeconds(0, 0);
  const { projects } = await loadProjectsConfig();

  await Promise.all(projects.flatMap((project) => project.jobs.map(async (job) => {
    const handler = jobHandlers.get(job.type);
    const state = await db.scheduledJobState.findUnique({
      where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
      select: { enabledOverride: true, scheduleOverride: true },
    });
    if (!handler || !matchesCron(effectiveJobSchedule(job, state), scheduledFor)) return;
    if (!(state?.enabledOverride ?? job.enabled)) return;
    await executeScheduledJob(db, project, job, scheduledFor, handler);
  })));
}

export async function runRequestedJobs(db: PrismaClient, config?: ProjectsConfig) {
  const resolvedConfig = config ?? await loadProjectsConfig();
  const requests = await db.scheduledJobRequest.findMany({
    where: { status: 'pending' },
    orderBy: { requestedAt: 'asc' },
  });
  for (const request of requests) {
    const claimed = await db.scheduledJobRequest.updateMany({
      where: { id: request.id, status: 'pending' },
      data: { status: 'processing', claimedAt: new Date() },
    });
    if (!claimed.count) continue;

    const project = resolvedConfig.projects.find(({ id }) => id === request.projectId);
    const job = project?.jobs.find(({ id }) => id === request.jobId);
    const handler = job && jobHandlers.get(job.type);
    if (!project || !job || !handler) {
      await db.scheduledJobRequest.update({
        where: { id: request.id },
        data: { status: 'failed', finishedAt: new Date(), error: 'project or job handler not found' },
      });
      continue;
    }

    void executeScheduledJob(db, project, job, request.requestedAt, handler, 'manual', request.id)
      .then(() => db.scheduledJobRequest.update({
        where: { id: request.id },
        data: { status: 'completed', finishedAt: new Date() },
      }))
      .catch((error) => db.scheduledJobRequest.update({
        where: { id: request.id },
        data: { status: 'failed', finishedAt: new Date(), error: errorText(error) },
      }));
  }
}

export async function startScheduledJobRunner(db: PrismaClient, signal: AbortSignal) {
  while (!signal.aborted) {
    await runRequestedJobs(db).catch((error) => console.error('[ScheduledJobRunner]', error));
    await runDueJobs(db).catch((error) => console.error('[ScheduledJobRunner]', error));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 15_000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
