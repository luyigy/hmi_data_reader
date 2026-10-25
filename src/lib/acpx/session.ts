import { prisma } from '@/lib/prisma';
import { DEFAULT_ACPX_PERMISSION_CONFIG, normalizeAcpxPermissionConfig } from './permissions';
import type { AcpxPermissionConfig } from './types';
import { finishPendingTaskRunInteractionRequests } from './interactions';

interface EnsureTaskSessionOptions {
  taskName?: string;
  metadata?: Record<string, unknown> | null;
}

const stringifyMetadata = (metadata?: Record<string, unknown> | null) =>
  metadata ? JSON.stringify(metadata) : null;

export const parseTaskSessionMetadata = (metadata: string | null | undefined): Record<string, unknown> => {
  if (!metadata) {
    return {};
  }

  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

export const readTaskSessionPermissionOverride = (
  taskSession: { metadata: string | null } | null | undefined
): AcpxPermissionConfig | null => {
  if (!taskSession?.metadata) {
    return null;
  }

  const metadata = parseTaskSessionMetadata(taskSession.metadata);
  const raw = metadata.sessionPermissionConfig;
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  return normalizeAcpxPermissionConfig(raw as Partial<AcpxPermissionConfig>);
};

export const resolveTaskSessionPermissionConfig = (args: {
  taskSession?: { metadata: string | null } | null;
  fallback?: Partial<AcpxPermissionConfig> | null;
}) =>
  readTaskSessionPermissionOverride(args.taskSession)
  || normalizeAcpxPermissionConfig(args.fallback ?? DEFAULT_ACPX_PERMISSION_CONFIG);

export const setTaskSessionPermissionOverride = async (args: {
  taskSessionId: string;
  permissionConfig: AcpxPermissionConfig;
  source: 'grant' | 'interaction_approve' | 'execute' | 'control_continue';
}) => {
  const session = await prisma.taskSession.findUnique({
    where: { id: args.taskSessionId },
    select: { metadata: true },
  });

  if (!session) {
    throw new Error(`Task session "${args.taskSessionId}" not found`);
  }

  const metadata = parseTaskSessionMetadata(session.metadata);
  const nextMetadata = {
    ...metadata,
    sessionPermissionConfig: args.permissionConfig,
    sessionPermissionSource: args.source,
    sessionPermissionUpdatedAt: new Date().toISOString(),
  };

  return prisma.taskSession.update({
    where: { id: args.taskSessionId },
    data: {
      metadata: stringifyMetadata(nextMetadata),
      updatedAt: new Date(),
    },
  });
};

export const ensureTaskSession = async (taskId: string, options: EnsureTaskSessionOptions = {}) => prisma.$transaction(async tx => {
  await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${taskId} FOR UPDATE`;
  const task = await tx.task.findUnique({
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

  const existingSession = await tx.taskSession.findFirst({
    where: { taskId },
    orderBy: { createdAt: 'desc' },
  });

  if (existingSession) {
    await tx.task.update({
      where: { id: taskId },
      data: {
        currentTaskSessionId: existingSession.id,
      },
    });

    return existingSession;
  }

  const session = await tx.taskSession.create({
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

  await tx.task.update({
    where: { id: taskId },
    data: {
      currentTaskSessionId: session.id,
    },
  });

  return session;
});

export const rotateTaskSession = async (taskId: string, options: EnsureTaskSessionOptions = {}) => {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { name: true, currentTaskSessionId: true },
  });

  if (!task) {
    throw new Error(`Task "${taskId}" not found`);
  }
  if (task.currentTaskSessionId) {
    await finishPendingTaskRunInteractionRequests({
      taskSessionId: task.currentTaskSessionId,
      status: 'cancelled',
    });
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
