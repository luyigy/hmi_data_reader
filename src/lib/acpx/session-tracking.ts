import { prisma } from '@/lib/prisma';
import { getHarnessAdapter } from '@/lib/harness';
import { normalizeAcpxPermissionConfig } from './permissions';
import type { AcpxParticipantRequest } from './types';
import type { AcpxPermissionConfig } from './types';

export const parseAcpxMetadata = (value: string | null | undefined): Record<string, unknown> => {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

export const getContinuationThreadId = (participant: {
  controlMetadata?: string | null;
  harnessType: string;
}) => {
  if (participant.harnessType !== 'codex') {
    return null;
  }

  const metadata = parseAcpxMetadata(participant.controlMetadata);
  const threadId = metadata.codexThreadId ?? metadata.lastSessionThreadId;
  return typeof threadId === 'string' && threadId.trim() ? threadId.trim() : null;
};

export const getContinuationSession = (participant: {
  controlMetadata?: string | null;
  harnessType: string;
}) => {
  const metadata = parseAcpxMetadata(participant.controlMetadata);
  const adapter = getHarnessAdapter(participant.harnessType);
  const explicitSessionId = typeof metadata.lastSessionId === 'string' && metadata.lastSessionId.trim()
    ? metadata.lastSessionId.trim()
    : null;
  const explicitSessionKind = typeof metadata.lastSessionKind === 'string' && metadata.lastSessionKind.trim()
    ? metadata.lastSessionKind.trim()
    : null;

  if (explicitSessionId) {
    return {
      sessionId: explicitSessionId,
      sessionKind: explicitSessionKind ?? (participant.harnessType === 'codex' ? 'codex_thread' : 'generic_session'),
    };
  }

  const adapterContinuation = adapter?.readContinuation?.(metadata);
  if (adapterContinuation?.sessionId) {
    return adapterContinuation;
  }

  if (participant.harnessType === 'codex') {
    const threadId = getContinuationThreadId(participant);
    if (threadId) {
      return {
        sessionId: threadId,
        sessionKind: 'codex_thread',
      };
    }
  }

  if (participant.harnessType === 'claude') {
    const sessionId = typeof metadata.claudeSessionId === 'string' && metadata.claudeSessionId.trim()
      ? metadata.claudeSessionId.trim()
      : null;
    if (sessionId) {
      return {
        sessionId,
        sessionKind: 'claude_session',
      };
    }
  }

  if (participant.harnessType === 'deepseek') {
    const sessionId = typeof metadata.deepseekThreadId === 'string' && metadata.deepseekThreadId.trim()
      ? metadata.deepseekThreadId.trim()
      : null;
    if (sessionId) {
      return {
        sessionId,
        sessionKind: 'deepseek_thread',
      };
    }
  }

  if (participant.harnessType === 'gemini-cli') {
    const sessionId = typeof metadata.geminiSessionId === 'string' && metadata.geminiSessionId.trim()
      ? metadata.geminiSessionId.trim()
      : null;
    if (sessionId) {
      return {
        sessionId,
        sessionKind: 'gemini_session',
      };
    }
  }

  return {
    sessionId: null,
    sessionKind: null,
  };
};

export const getParticipantContinuationKey = (
  participant: Pick<AcpxParticipantRequest, 'continuationKey' | 'executionBackend' | 'gatewayId' | 'harnessType' | 'role' | 'agentId'>
) =>
  participant.continuationKey?.trim()
  || [
    participant.executionBackend,
    participant.gatewayId || 'local',
    participant.harnessType,
    participant.role,
    participant.agentId || 'default',
  ].join(':');

const readContinuationKeyFromMetadata = (controlMetadata?: string | null) => {
  const metadata = parseAcpxMetadata(controlMetadata);
  return typeof metadata.continuationKey === 'string' && metadata.continuationKey.trim()
    ? metadata.continuationKey.trim()
    : null;
};

export const findLatestParticipantSession = async (
  taskId: string,
  participant: Pick<AcpxParticipantRequest, 'continuationKey' | 'executionBackend' | 'gatewayId' | 'harnessType' | 'role' | 'agentId'>,
  options?: {
    taskSessionId?: string | null;
    permissionConfig?: AcpxPermissionConfig | null;
  }
) => {
  const expectedContinuationKey = getParticipantContinuationKey(participant);
  const candidates = await prisma.taskRunParticipant.findMany({
    where: {
      taskRun: {
        taskId,
        ...(options?.taskSessionId ? { taskSessionId: options.taskSessionId } : {}),
      },
      executionBackend: participant.executionBackend,
      gatewayId: participant.gatewayId || null,
      harnessType: participant.harnessType,
      role: participant.role,
      agentId: participant.agentId || null,
    },
    include: {
      taskRun: {
        select: {
          status: true,
          updatedAt: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: 20,
  });

  const isContinuationMarkedStale = (controlMetadata?: string | null) => {
    const metadata = parseAcpxMetadata(controlMetadata);
    return typeof metadata.continuationStaleAt === 'string' && metadata.continuationStaleAt.trim().length > 0;
  };

  const expectedPermissionConfig = options?.permissionConfig
    ? normalizeAcpxPermissionConfig(options.permissionConfig)
    : null;

  const viableCandidates = candidates.filter((candidate) => {
    if (readContinuationKeyFromMetadata(candidate.controlMetadata) !== expectedContinuationKey) {
      return false;
    }

    if (isContinuationMarkedStale(candidate.controlMetadata)) {
      return false;
    }

    if (candidate.status !== 'completed') {
      return false;
    }

    if (candidate.taskRun.status === 'failed' || candidate.taskRun.status === 'stopped') {
      return false;
    }

    if (expectedPermissionConfig) {
      const metadata = parseAcpxMetadata(candidate.controlMetadata);
      const candidatePermissionConfig = metadata.permissionConfig && typeof metadata.permissionConfig === 'object'
        ? normalizeAcpxPermissionConfig(metadata.permissionConfig as Partial<AcpxPermissionConfig>)
        : null;
      if (!candidatePermissionConfig) {
        return false;
      }

      if (JSON.stringify(candidatePermissionConfig) !== JSON.stringify(expectedPermissionConfig)) {
        return false;
      }
    }

    return Boolean(getContinuationSession(candidate).sessionId);
  });

  const matched = viableCandidates[0] || null;

  return matched
    ? {
        participant: matched,
        continuationThreadId: getContinuationThreadId(matched),
        continuationSessionId: getContinuationSession(matched).sessionId,
        continuationSessionKind: getContinuationSession(matched).sessionKind,
      }
    : null;
};

export const markParticipantContinuationStale = async ({
  participantId,
  reason,
}: {
  participantId: string;
  reason: string;
}) => {
  const participant = await prisma.taskRunParticipant.findUnique({
    where: { id: participantId },
    select: {
      controlMetadata: true,
    },
  });

  if (!participant) {
    return;
  }

  const metadata = parseAcpxMetadata(participant.controlMetadata);
  delete metadata.lastSessionId;
  delete metadata.lastSessionKind;
  delete metadata.lastSessionThreadId;
  delete metadata.codexThreadId;
  delete metadata.claudeSessionId;
  delete metadata.deepseekThreadId;
  delete metadata.geminiSessionId;
  delete metadata.piSessionDir;

  await prisma.taskRunParticipant.update({
    where: { id: participantId },
    data: {
      controlMetadata: JSON.stringify({
        ...metadata,
        continuationStaleAt: new Date().toISOString(),
        continuationStaleReason: reason,
      }),
    },
  });
};
