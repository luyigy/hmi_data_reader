import { prisma } from '@/lib/prisma';
import type { HarnessInteractionRequest, HarnessInteractionRequestKind } from './types';
import { cancelInProcessApproval } from './in-process-approvals';
import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import type { ResourceInput } from '../task-resources/model';

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

export const nativePermissionResources = (request: Pick<HarnessInteractionRequest, 'nativePermission'>): ResourceInput[] | null => {
  const native = request.nativePermission;
  if (!native || native.method === 'item/commandExecution/requestApproval') return [];
  if (native.method === 'item/fileChange/requestApproval') {
    return native.grantRoot && path.isAbsolute(native.grantRoot) ? [{ path: native.grantRoot, access: 'write' }] : null;
  }
  if (native.method !== 'item/permissions/requestApproval') return null;
  const permissions = native.permissions;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return null;
  // Additional permission kinds (including network expansion) have no directory grant semantics.
  if (Object.keys(permissions).some(key => key !== 'fileSystem' && !(key === 'network' && (permissions as Record<string, unknown>)[key] == null))) return null;
  const fs = (permissions as Record<string, unknown>).fileSystem;
  if (!fs || typeof fs !== 'object' || Array.isArray(fs) || Object.keys(fs).some(key => !['read', 'write', 'entries', 'globScanMaxDepth'].includes(key))) return null;
  const resources: ResourceInput[] = [];
  const entries = (fs as Record<string, unknown>).entries;
  if (entries != null) {
    if (!Array.isArray(entries)) return null;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['access', 'path'].includes(key))
        || !['read', 'write'].includes(entry.access) || !entry.path || entry.path.type !== 'path'
        || Object.keys(entry.path).some(key => !['type', 'path'].includes(key))
        || typeof entry.path.path !== 'string' || !path.isAbsolute(entry.path.path)) return null;
      resources.push({ path: entry.path.path, access: entry.access });
    }
  }
  for (const access of ['read', 'write'] as const) {
    const paths = (fs as Record<string, unknown>)[access];
    if (paths == null) continue;
    if (!Array.isArray(paths) || paths.some(value => typeof value !== 'string' || !path.isAbsolute(value))) return null;
    resources.push(...paths.map(value => ({ path: value as string, access })));
  }
  return resources.length ? resources : null;
};

const canonicalPath = (value: string): string => {
  try { return realpathSync(value); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.join(canonicalPath(parent), path.basename(value));
  }
};

export const permissionResourceDirectory = (value: string): string => {
  let candidate = value;
  for (;;) {
    try {
      return statSync(candidate).isDirectory() ? realpathSync(candidate) : realpathSync(path.dirname(candidate));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
};

export const isPermissionRequestWithinBoundary = (args: {
  kind: string;
  title?: string;
  rawContent: string;
  nativePermission?: HarnessInteractionRequest['nativePermission'];
  workspaceBoundary?: string;
  writableRoots?: string[];
  readableRoots?: string[];
}) => {
  if (args.kind !== 'permission_request') return true;
  const resources = nativePermissionResources(args);
  if (!resources) return false;
  const writes = args.writableRoots ?? (args.workspaceBoundary ? [args.workspaceBoundary] : []);
  try {
    return resources.every(resource => (resource.access === 'write' ? writes : [...writes, ...(args.readableRoots || [])]).some(root => {
      const relative = path.relative(canonicalPath(root), canonicalPath(resource.path));
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }));
  } catch { return false; }
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
