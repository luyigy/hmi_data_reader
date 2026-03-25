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
      }
    : null;
};
