import { prisma } from '@/lib/prisma';
import type { AcpxParticipantRequest } from './types';

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
  participant: Pick<AcpxParticipantRequest, 'continuationKey' | 'executionBackend' | 'gatewayId' | 'harnessType' | 'role' | 'agentId'>
) => {
  const expectedContinuationKey = getParticipantContinuationKey(participant);
  const candidates = await prisma.taskRunParticipant.findMany({
    where: {
      taskRun: {
        taskId,
      },
      executionBackend: participant.executionBackend,
      gatewayId: participant.gatewayId || null,
      harnessType: participant.harnessType,
      role: participant.role,
      agentId: participant.agentId || null,
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: 20,
  });

  const matched =
    candidates.find((candidate) => readContinuationKeyFromMetadata(candidate.controlMetadata) === expectedContinuationKey)
    || candidates[0]
    || null;

  return matched
    ? {
        participant: matched,
        continuationThreadId: getContinuationThreadId(matched),
        continuationSessionId: getContinuationSession(matched).sessionId,
        continuationSessionKind: getContinuationSession(matched).sessionKind,
      }
    : null;
};
