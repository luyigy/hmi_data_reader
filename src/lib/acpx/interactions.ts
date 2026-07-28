import { prisma } from '@/lib/prisma';
import type { HarnessInteractionRequestKind } from './types';
import { cancelInProcessApproval } from './in-process-approvals';
import path from 'node:path';

const stringifyJson = (value?: Record<string, unknown> | Array<unknown> | null) =>
  value ? JSON.stringify(value) : null;

const parseJsonObject = (value?: string | null) => {
  if (!value) {
    return {} as Record<string, unknown>;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const parseJsonArray = (value?: string | null) => {
  if (!value) {
    return [] as Array<Record<string, unknown>>;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
  } catch {
    return [];
  }
};

export const isPermissionRequestWithinBoundary = (args: {
  kind: string;
  title?: string;
  rawContent: string;
  workspaceBoundary?: string;
}) => {
  if (args.kind !== 'permission_request'
    || args.title !== 'Codex 请求修改文件'
    || !args.workspaceBoundary) return true;
  const requestedPath = args.rawContent.split('\n')[0];
  if (!requestedPath?.startsWith('/')) return true;
  const relative = path.relative(args.workspaceBoundary, path.resolve(requestedPath));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export type TaskRunInteractionRequestStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'answered'
  | 'expired'
  | 'cancelled';

export type TaskRunInteractionRequestRecord = {
  id: string;
  taskId: string;
  taskSessionId: string | null;
  taskRunId: string;
  participantId: string | null;
  roomMessageId: string | null;
  source: string;
  requestKind: HarnessInteractionRequestKind | string;
  status: TaskRunInteractionRequestStatus | string;
  title: string | null;
  message: string;
  rawPayload: Record<string, unknown> | null;
  options: Array<Record<string, unknown>>;
  defaultAnswer: string | null;
  responseText: string | null;
  responseMetadata: Record<string, unknown> | null;
  requestedAt: string;
  resolvedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const mapInteractionRequest = (
  row: Awaited<ReturnType<typeof prisma.taskRunInteractionRequest.findUniqueOrThrow>>
): TaskRunInteractionRequestRecord => ({
  id: row.id,
  taskId: row.taskId,
  taskSessionId: row.taskSessionId,
  taskRunId: row.taskRunId,
  participantId: row.participantId,
  roomMessageId: row.roomMessageId,
  source: row.source,
  requestKind: row.requestKind,
  status: row.status,
  title: row.title,
  message: row.message,
  rawPayload: row.rawPayload ? parseJsonObject(row.rawPayload) : null,
  options: parseJsonArray(row.optionsJson),
  defaultAnswer: row.defaultAnswer,
  responseText: row.responseText,
  responseMetadata: row.responseMetadata ? parseJsonObject(row.responseMetadata) : null,
  requestedAt: row.requestedAt.toISOString(),
  resolvedAt: row.resolvedAt?.toISOString() || null,
  expiresAt: row.expiresAt?.toISOString() || null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const createTaskRunInteractionRequest = async (args: {
  taskId: string;
  taskSessionId?: string | null;
  taskRunId: string;
  participantId?: string | null;
  roomMessageId?: string | null;
  source?: 'harness' | 'system';
  requestKind: HarnessInteractionRequestKind | string;
  title?: string | null;
  message: string;
  rawPayload?: Record<string, unknown> | null;
  options?: Array<Record<string, unknown>>;
  defaultAnswer?: string | null;
  expiresAt?: Date | null;
}) => {
  const created = await prisma.taskRunInteractionRequest.create({
    data: {
      taskId: args.taskId,
      taskSessionId: args.taskSessionId ?? null,
      taskRunId: args.taskRunId,
      participantId: args.participantId ?? null,
      roomMessageId: args.roomMessageId ?? null,
      source: args.source ?? 'harness',
      requestKind: args.requestKind,
      title: args.title ?? null,
      message: args.message,
      rawPayload: stringifyJson(args.rawPayload ?? null),
      optionsJson: stringifyJson(args.options ?? null),
      defaultAnswer: args.defaultAnswer ?? null,
      expiresAt: args.expiresAt ?? null,
    },
  });

  return mapInteractionRequest(created);
};

export const findRecentPendingInteractionRequest = async (args: {
  taskRunId: string;
  participantId?: string | null;
  requestKind: HarnessInteractionRequestKind | string;
  message: string;
}) => {
  const existing = await prisma.taskRunInteractionRequest.findFirst({
    where: {
      taskRunId: args.taskRunId,
      participantId: args.participantId ?? null,
      requestKind: args.requestKind,
      status: 'pending',
      message: args.message,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return existing ? mapInteractionRequest(existing) : null;
};

export const listPendingTaskRunInteractionRequests = async (args: {
  taskId?: string;
  taskRunId?: string;
  participantId?: string;
}) => {
  const rows = await prisma.taskRunInteractionRequest.findMany({
    where: {
      status: 'pending',
      ...(args.taskId ? { taskId: args.taskId } : {}),
      ...(args.taskRunId ? { taskRunId: args.taskRunId } : {}),
      ...(args.participantId ? { participantId: args.participantId } : {}),
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  return rows.map(mapInteractionRequest);
};

export const getTaskRunInteractionRequestById = async (id: string) => {
  const row = await prisma.taskRunInteractionRequest.findUnique({
    where: { id },
  });

  return row ? mapInteractionRequest(row) : null;
};

export const resolveTaskRunInteractionRequest = async (args: {
  id: string;
  status: Exclude<TaskRunInteractionRequestStatus, 'pending' | 'expired'>;
  responseText?: string | null;
  responseMetadata?: Record<string, unknown> | null;
}) => {
  const existing = await prisma.taskRunInteractionRequest.findUnique({
    where: { id: args.id },
  });

  if (!existing || existing.status !== 'pending') {
    return null;
  }

  const updated = await prisma.taskRunInteractionRequest.update({
    where: { id: args.id },
    data: {
      status: args.status,
      responseText: args.responseText ?? null,
      responseMetadata: stringifyJson(args.responseMetadata ?? null),
      resolvedAt: new Date(),
    },
  });

  return mapInteractionRequest(updated);
};

export const expireStaleTaskRunInteractionRequests = async (now = new Date()) => {
  const pending = await prisma.taskRunInteractionRequest.findMany({
    where: {
      status: 'pending',
      expiresAt: {
        lte: now,
      },
    },
  });

  if (pending.length === 0) {
    return [];
  }

  await prisma.taskRunInteractionRequest.updateMany({
    where: {
      id: {
        in: pending.map((row) => row.id),
      },
    },
    data: {
      status: 'expired',
      resolvedAt: now,
    },
  });

  pending.forEach((row) => cancelInProcessApproval(row.id));
  return pending.map(mapInteractionRequest);
};

export const finishPendingTaskRunInteractionRequests = async (args: {
  taskRunId?: string;
  taskSessionId?: string;
  participantId?: string;
  status: 'cancelled' | 'expired';
}) => {
  if (!args.taskRunId && !args.taskSessionId && !args.participantId) {
    throw new Error('Interaction cleanup requires a run, session, or participant scope');
  }
  const pending = await prisma.taskRunInteractionRequest.findMany({
    where: {
      status: 'pending',
      ...(args.taskRunId ? { taskRunId: args.taskRunId } : {}),
      ...(args.taskSessionId ? { taskSessionId: args.taskSessionId } : {}),
      ...(args.participantId ? { participantId: args.participantId } : {}),
    },
    select: { id: true },
  });
  if (!pending.length) return 0;
  const resolvedAt = new Date();
  await prisma.taskRunInteractionRequest.updateMany({
    where: { id: { in: pending.map(({ id }) => id) }, status: 'pending' },
    data: { status: args.status, resolvedAt },
  });
  pending.forEach(({ id }) => cancelInProcessApproval(id));
  return pending.length;
};
