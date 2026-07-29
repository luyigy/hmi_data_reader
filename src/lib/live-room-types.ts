import type { AcpxExecutionBackend } from "@/lib/acpx/types";

export interface LiveRoomCatalogAgent {
  id: string;
  agentRecordId?: string | null;
  gatewayId: string;
  gatewayName: string;
  backend: AcpxExecutionBackend;
  harnessType: string;
  label: string;
  agentName?: string;
  userNickname?: string | null;  // User-defined nickname
  hostname?: string | null;       // Server hostname
  runtimeAgentId?: string;
  status: string;
}

const REMOTE_HOST_ROLE_LABEL_PREFIX = '__remote_host__:';
const LIVE_ROOM_ACPX_PARTICIPANT_PREFIX = 'live-room-member:';

export const encodeLiveRoomRoleLabel = ({
  backend,
  label,
  remoteHostId,
}: {
  backend: string;
  label: string;
  remoteHostId?: string | null;
}) => {
  if (backend === 'remote_ssh' && remoteHostId) {
    return `${label} ${REMOTE_HOST_ROLE_LABEL_PREFIX}${remoteHostId}`;
  }

  return label;
};

export const extractRemoteHostIdFromRoleLabel = (value?: string | null) => {
  const match = value?.match(/__remote_host__:([^\s]+)/);
  return match?.[1] || null;
};

export const getLiveRoomParticipantContinuationKey = (memberId: string) =>
  `${LIVE_ROOM_ACPX_PARTICIPANT_PREFIX}${memberId}`;

export interface LiveRoomMemberPayload {
  id: string;
  roomId: string;
  memberType: string;
  displayName: string;
  agentNameSnapshot: string | null;
  harnessType: string | null;
  backend: string | null;
  runtimeAgentId: string | null;
  roleLabel: string | null;
  role: string;
  joinStatus: string;
  presenceStatus: string;
  canReply: boolean;
  sortOrder: number;
  gatewayId: string | null;
  gatewayName: string | null;
  agentRecordId: string | null;
  acpxPermissionConfig?: string | null;
  codexModel?: string | null;
  codexReasoningEffort?: string | null;
  permissionProfile: string | null;
  permissionLabel: string | null;
  contextWatermark?: LiveRoomMemberContextWatermarkPayload | null;
}

export interface LiveRoomMemberContextWatermarkPayload {
  usagePercentage: number;
  usageStatus: 'light' | 'elevated' | 'high';
  policyStatus: 'normal' | 'warning' | 'critical';
  policyLabel: string;
  dominantReason: 'messages' | 'events' | 'transcript';
  dominantLabel: string;
  recommendedAction: string;
  messageCount: number;
  eventCount: number;
  transcriptChars: number;
  remainingMessages: number;
  remainingEvents: number;
  remainingTranscriptChars: number;
}

export const LIVE_ROOM_CONTEXT_POLICY_STATUS_PRIORITY = {
  normal: 0,
  warning: 1,
  critical: 2,
} as const;

export interface LiveRoomMessagePayload {
  id: string;
  roomId: string;
  senderMemberId: string | null;
  senderName: string;
  senderLabel: string;
  senderType: string;
  content: string;
  messageType: string;
  visibility: string;
  topicSnapshot: string | null;
  createdAt: string;
  replyToMessageId: string | null;
  metadata: Record<string, unknown> | null;
}

export type LiveRoomDeliveryIntent =
  | 'broadcast'
  | 'directed_visible'
  | 'user_target'
  | 'mention'
  | 'ask'
  | 'handoff'
  | 'mention_all';

export interface LiveRoomMessageMetadata {
  senderKind?: 'user' | 'assistant' | 'system';
  mentionedMemberIds?: string[];
  primaryTargetMemberId?: string | null;
  deliveryIntent?: LiveRoomDeliveryIntent;
  visibilityMode?: 'room' | 'directed_visible';
  inReplyToMessageId?: string | null;
  handoffToMemberId?: string | null;
  mentionedAll?: boolean;
  expectedResponderMemberIds?: string[];
  requiredResponseMode?: 'none' | 'any_one' | 'all';
  [key: string]: unknown;
}

export interface LiveRoomSummaryPayload {
  id: string;
  title: string;
  description: string | null;
  currentTopic: string | null;
  mode: string;
  status: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  currentSpeakerMemberId: string | null;
  currentSpeakerName: string | null;
  memberCount: number;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
}

export interface LiveRoomPendingReplyPayload {
  memberId: string;
  displayName: string;
  pendingCount: number;
  queuedCount: number;
  runningCount: number;
  oldestPendingAt: string;
  newestPendingAt: string;
  newestPendingAgeSeconds: number;
  lastProgressAt?: string | null;
  lastProgressAgeSeconds?: number | null;
  progressLabel?: string | null;
  activeDeliveryId?: string | null;
  backend?: string | null;
  harnessType?: string | null;
  interruptSupported?: boolean;
  status: 'queued' | 'running' | 'stalled';
}

export interface LiveRoomMentionableMember {
  id: string;
  displayName: string;
  runtimeAgentId?: string | null;
  gateway?: {
    name: string;
  } | null;
  harnessType?: string | null;
  canReply?: boolean;
}

export const detectLiveRoomMentionAll = (content: string) => /(^|[\s(])[@$]all\b/i.test(content);

export const getLiveRoomMemberRosterLabel = (member: {
  displayName: string;
  memberType?: string;
  backend?: string | null;
  gateway?: { name: string } | null;
  gatewayName?: string | null;
  harnessType?: string | null;
  canReply?: boolean;
}) => {
  if (member.memberType === 'user') {
    return `${member.displayName} / user`;
  }

  const sourceLabel =
    member.backend === 'platform_local'
      ? 'Platform Local'
      : member.backend === 'remote_ssh'
      ? `Remote SSH · ${member.gateway?.name || member.gatewayName || 'Remote Host'}`
      : (member.gateway?.name || member.gatewayName || 'Gateway');

  return `${member.displayName} / ${sourceLabel} / ${member.harnessType || 'agent'}${member.canReply ? ' / can-reply' : ''}`;
};

export const buildLiveRoomRosterText = (members: Array<{
  displayName: string;
  memberType?: string;
  backend?: string | null;
  gateway?: { name: string } | null;
  gatewayName?: string | null;
  harnessType?: string | null;
  canReply?: boolean;
}>) => members.map((member) => `- ${getLiveRoomMemberRosterLabel(member)}`).join('\n');


