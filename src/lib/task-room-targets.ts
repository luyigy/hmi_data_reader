import type { AcpxParticipantRequest } from '@/lib/acpx/types';

const normalizeTextPart = (value?: string | null) =>
  (value || '').trim().toLowerCase().replace(/\s+/g, '-');

export const getTaskRoomParticipantTargetKey = (participant: {
  executionBackend: string;
  gatewayId?: string | null;
  harnessType: string;
  role: string;
  agentId?: string | null;
  continuationKey?: string | null;
}) =>
  [
    normalizeTextPart(participant.executionBackend),
    normalizeTextPart(participant.gatewayId || 'local'),
    normalizeTextPart(participant.harnessType),
    normalizeTextPart(participant.role),
    normalizeTextPart(participant.continuationKey || participant.agentId || 'default'),
  ].join(':');

export const getTaskRoomParticipantTargetLabel = (participant: AcpxParticipantRequest) =>
  `${participant.role} · ${
    participant.executionBackend === 'platform_local'
      ? 'Platform Local'
      : participant.executionBackend === 'remote_ssh'
      ? `Remote SSH · ${participant.gatewayName || participant.gatewayId}`
      : (participant.gatewayName || participant.gatewayId)
  } / ${participant.harnessType}`;

export const formatTaskRoomMessageTargetPrefix = ({
  targetType,
  targetParticipantLabel,
}: {
  targetType: string;
  targetParticipantLabel?: string | null;
}) => {
  if (targetType === 'all') {
    return '[发给全部参与方] ';
  }

  if (targetType === 'participant' && targetParticipantLabel) {
    return `[发给 ${targetParticipantLabel}] `;
  }

  return '';
};
