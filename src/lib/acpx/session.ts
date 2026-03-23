import { prisma } from '@/lib/prisma';

interface EnsureTaskSessionOptions {
  taskName?: string;
  metadata?: Record<string, unknown> | null;
}

const stringifyMetadata = (metadata?: Record<string, unknown> | null) =>
  metadata ? JSON.stringify(metadata) : null;

export const ensureTaskSession = async (taskId: string, options: EnsureTaskSessionOptions = {}) => {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      currentTaskSession: true,
    },
  });

  if (!task) {
    throw new Error(`Task "${taskId}" not found`);
  }

  if (task.currentTaskSession) {
    return task.currentTaskSession;
  }

  const existingSession = await prisma.taskSession.findFirst({
    where: { taskId },
    orderBy: { createdAt: 'desc' },
  });

  if (existingSession) {
    await prisma.task.update({
      where: { id: taskId },
      data: {
        currentTaskSessionId: existingSession.id,
      },
    });

    return existingSession;
  }

  const session = await prisma.taskSession.create({
    data: {
      taskId,
      status: 'active',
      attentionState: 'normal',
      metadata: stringifyMetadata({
        taskName: options.taskName ?? task.name,
        ...(options.metadata ?? {}),
      }),
    },
  });

  await prisma.task.update({
    where: { id: taskId },
    data: {
      currentTaskSessionId: session.id,
    },
  });

  return session;
};

export const setTaskSessionActiveRun = async (taskSessionId: string, taskRunId: string | null) =>
  prisma.taskSession.update({
    where: { id: taskSessionId },
    data: {
      activeRunId: taskRunId,
      updatedAt: new Date(),
    },
  });
