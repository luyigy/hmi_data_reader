import { Prisma, PrismaClient } from '@prisma/client';
import { jobHandlers, type JobHandler } from './handlers';
import { loadProjectsConfig, type JobConfig, type JobMode, type ProjectConfig } from './project-config';

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

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const withTimeout = async <T>(milliseconds: number, handler: (signal: AbortSignal) => Promise<T>) => {
  const controller = new AbortController();
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
) {
  const idempotencyKey = `schedule:${project.id}:${job.id}:${scheduledFor.toISOString()}`;
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
        trigger: 'schedule',
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
  let cursor: unknown;
  let failure: string | undefined;

  try {
    const result = await db.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${`${project.id}:${job.id}`}, 0)) AS locked
      `;
      if (!locked) return null;

      await tx.scheduledJobState.upsert({
        where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
        create: { projectId: project.id, jobId: job.id, lastScheduledAt: scheduledFor, lastStartedAt: startedAt },
        update: { lastScheduledAt: scheduledFor, lastStartedAt: startedAt },
      });
      return withTimeout(timeoutMs, (signal) => handler({
        project,
        job,
        mode,
        cursor: state?.cursorJson,
        signal,
      }));
    }, { maxWait: 5_000, timeout: timeoutMs + 5_000 });

    if (!result) {
      status = 'skipped';
      summary = 'job already running';
    } else {
      summary = result.summary;
      cursor = result.cursor;
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
        cursorJson: status === 'succeeded' && cursor !== undefined ? cursor as Prisma.InputJsonValue : undefined,
      },
      update: {
        lastScheduledAt: scheduledFor,
        lastStartedAt: startedAt,
        lastFinishedAt: finishedAt,
        lastSuccessAt: status === 'succeeded' ? finishedAt : undefined,
        lastError: failure ?? null,
        cursorJson: status === 'succeeded' && cursor !== undefined ? cursor as Prisma.InputJsonValue : undefined,
      },
    }),
  ]);
  return status === 'succeeded';
}

export async function runDueJobs(db: PrismaClient, now = new Date()) {
  const scheduledFor = new Date(now);
  scheduledFor.setSeconds(0, 0);
  const { projects } = await loadProjectsConfig();

  await Promise.all(projects.flatMap((project) => project.jobs.map(async (job) => {
    const handler = jobHandlers.get(job.type);
    if (!handler || !matchesCron(job.schedule, scheduledFor)) return;
    const state = await db.scheduledJobState.findUnique({
      where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
      select: { enabledOverride: true },
    });
    if (!(state?.enabledOverride ?? job.enabled)) return;
    await executeScheduledJob(db, project, job, scheduledFor, handler);
  })));
}

export async function startScheduledJobRunner(db: PrismaClient, signal: AbortSignal) {
  while (!signal.aborted) {
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
