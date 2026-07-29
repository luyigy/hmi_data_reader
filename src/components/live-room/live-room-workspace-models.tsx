import type {
  LiveRoomCatalogAgent,
  LiveRoomMessage,
  WorkspaceDetail,
  WorkspaceSummary,
} from '@/types';

export interface WorkspacesResponse {
  workspaces: WorkspaceSummary[];
  availableAgents: LiveRoomCatalogAgent[];
}

export type PendingReply = NonNullable<WorkspaceDetail['pendingReplies']>[number];

export type MentionCandidate =
  | { kind: 'all'; id: '__all__'; label: '$all'; subtitle: string }
  | { kind: 'member'; member: WorkspaceDetail['members'][number] };

export const ROOMS_PANEL_KEY = 'live-room-left-panel-open';
export const DETAILS_PANEL_KEY = 'live-room-right-panel-open';
export const DISABLE_LIVE_ROOM_SOCKET_AND_POLLING = true;
export const MEMBER_ROLES = ['planner', 'implementer', 'reviewer', 'tester', 'researcher', 'custom'] as const;
export const PERMISSION_PROFILES = ['safe_local', 'dev_local', 'full_access'] as const;
export const CODEX_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const getPermissionProfileLabel = (profile: string) =>
  profile === 'full_access' ? 'Full Access' : profile === 'dev_local' ? 'Dev Local' : 'Safe Local';

export const getAgentLabel = (agent: LiveRoomCatalogAgent) =>
  `${agent.agentName || agent.label} · ${
    agent.backend === 'remote_ssh' ? `Remote SSH · ${agent.gatewayName}` : agent.gatewayName
  } / ${agent.harnessType}`;

export const getMemberLabel = (member: WorkspaceDetail['members'][number]) =>
  member.memberType === 'user'
    ? member.displayName
    : `${member.displayName} · ${
        member.backend === 'platform_local'
          ? 'Platform Local'
          : member.backend === 'remote_ssh'
          ? `Remote SSH · ${member.gatewayName || 'Remote Host'}`
          : (member.gatewayName || 'Gateway')
      } / ${member.harnessType || 'agent'}`;

export const getMemberSubtitle = (member: WorkspaceDetail['members'][number]) =>
  member.memberType === 'user'
    ? '你'
    : `${
        member.backend === 'platform_local'
          ? 'Platform Local'
          : member.backend === 'remote_ssh'
          ? `Remote SSH · ${member.gatewayName || 'Remote Host'}`
          : (member.gatewayName || 'Gateway')
      } / ${member.harnessType || 'agent'}`;

export const getPermissionBadgeTone = (profile?: string | null) => {
  if (profile === 'full_access') return 'bg-rose-100 text-rose-700';
  if (profile === 'dev_local') return 'bg-amber-100 text-amber-700';
  if (profile === 'safe_local') return 'bg-emerald-100 text-emerald-700';
  return 'bg-slate-100 text-slate-600';
};

export const getWatermarkUsageBarTone = (usageStatus?: string | null) => {
  if (usageStatus === 'high') return 'bg-amber-500';
  if (usageStatus === 'elevated') return 'bg-sky-500';
  return 'bg-slate-400';
};

export const getWatermarkPolicyTone = (policyStatus?: string | null) => {
  if (policyStatus === 'critical') return 'bg-rose-100 text-rose-700';
  if (policyStatus === 'warning') return 'bg-amber-100 text-amber-700';
  return 'bg-emerald-100 text-emerald-700';
};

export const getWatermarkPolicyLabel = (member: WorkspaceDetail['members'][number]) => {
  const watermark = member.contextWatermark;
  if (!watermark) {
    return null;
  }

  if (watermark.policyStatus === 'critical') return 'Reset now';
  if (watermark.policyStatus === 'warning') return 'Warning';
  return 'Within policy';
};

export const getWatermarkUsageLabel = (member: WorkspaceDetail['members'][number]) => {
  const watermark = member.contextWatermark;
  if (!watermark) {
    return null;
  }

  return `Used ${watermark.usagePercentage}%`;
};

export const getWatermarkTooltip = (member: WorkspaceDetail['members'][number]) => {
  const watermark = member.contextWatermark;
  if (!watermark) {
    return '';
  }

  return [
    `usage: ${watermark.usagePercentage}% (${watermark.dominantLabel})`,
    `policy: ${watermark.policyLabel}`,
    `${watermark.messageCount}/60 messages`,
    `${watermark.eventCount}/400 events`,
    `${watermark.transcriptChars}/4000 transcript chars`,
    watermark.recommendedAction,
  ].join(' | ');
};

export const getMentionQuery = (value: string) => value.match(/@([\w\u4e00-\u9fa5-]*)$/)?.[1] ?? '';
export const hasMentionAll = (value: string) => /(^|[\s(])[@$]all\b/i.test(value);

export const formatPendingAge = (seconds?: number) => {
  if (!seconds || seconds <= 0) {
    return '刚开始';
  }

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  if (minutes < 60) {
    return remainSeconds > 0 ? `${minutes}m ${remainSeconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
};

export const getPendingReplyStatusLabel = (reply: PendingReply) => {
  if (reply.status === 'queued') {
    return reply.pendingCount > 1
      ? `排队中（共 ${reply.pendingCount} 条，尚未开始）`
      : '排队中（尚未开始）';
  }

  if (reply.status === 'stalled') {
    return `远端可能卡住（已等待 ${formatPendingAge(reply.newestPendingAgeSeconds)}）`;
  }

  const progress = reply.progressLabel || '正在执行';
  const queueSuffix = reply.queuedCount > 0 ? `，后面还有 ${reply.queuedCount} 条排队` : '';
  return `${progress}（${formatPendingAge(reply.newestPendingAgeSeconds)}）${queueSuffix}`;
};

export const getWorkspaceStatusLabel = (status: WorkspaceSummary['workspaceStatus']) => {
  if (status === 'waiting_for_you') return 'waiting';
  if (status === 'failed') return 'failed';
  if (status === 'running') return 'running';
  if (status === 'archived') return 'archived';
  return 'idle';
};

export const getAttentionLabel = (attentionState: WorkspaceSummary['attentionState']) => {
  if (attentionState === 'waiting_for_you') return 'needs you';
  if (attentionState === 'failed') return 'failed';
  if (attentionState === 'new_updates') return 'updates';
  return 'quiet';
};

export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 80;

export const getMessageMetadataValue = (message: LiveRoomMessage, key: string) =>
  (message.metadata && typeof message.metadata[key] !== 'undefined') ? message.metadata[key] : null;

export const getLiveRoomSystemEvent = (message: LiveRoomMessage) => {
  const value = getMessageMetadataValue(message, 'systemEvent');
  return typeof value === 'string' ? value : null;
};

export const getDirectedTargetMember = (
  message: LiveRoomMessage,
  room: WorkspaceDetail | null
) => {
  const targetMemberId = getMessageMetadataValue(message, 'primaryTargetMemberId');
  if (typeof targetMemberId !== 'string') {
    return null;
  }

  return room?.members.find((member) => member.id === targetMemberId) || null;
};

export const renderLiveRoomSystemMessage = (
  message: LiveRoomMessage,
  room: WorkspaceDetail | null
) => {
  const systemEvent = getLiveRoomSystemEvent(message);
  if (!systemEvent || !['member_reply_started', 'member_reply_progress', 'member_reply_tool'].includes(systemEvent)) {
    return null;
  }

  const targetMember = getDirectedTargetMember(message, room);
  const targetLabel = targetMember?.displayName || message.senderLabel || message.senderName || 'Agent';
  const preview = typeof getMessageMetadataValue(message, 'preview') === 'string'
    ? String(getMessageMetadataValue(message, 'preview'))
    : '';
  const stream = typeof getMessageMetadataValue(message, 'stream') === 'string'
    ? String(getMessageMetadataValue(message, 'stream'))
    : null;
  const toolName = typeof getMessageMetadataValue(message, 'toolName') === 'string'
    ? String(getMessageMetadataValue(message, 'toolName'))
    : null;
  const toolEmoji = typeof getMessageMetadataValue(message, 'toolEmoji') === 'string'
    ? String(getMessageMetadataValue(message, 'toolEmoji'))
    : '⚙️';
  const isTool = systemEvent === 'member_reply_tool';
  const isStarted = systemEvent === 'member_reply_started';
  const isStderr = stream === 'stderr';

  const toneClass = isTool
    ? 'border-sky-200 bg-sky-50/80 text-sky-900'
    : isStderr
    ? 'border-rose-200 bg-rose-50/80 text-rose-900'
    : 'border-emerald-200 bg-emerald-50/80 text-emerald-900';
  const pillClass = isTool
    ? 'bg-sky-100 text-sky-700'
    : isStderr
    ? 'bg-rose-100 text-rose-700'
    : 'bg-emerald-100 text-emerald-700';
  const barClass = isTool
    ? 'bg-sky-400'
    : isStderr
    ? 'bg-rose-400'
    : 'bg-emerald-400';
  const title = isTool
    ? `${toolEmoji} ${targetLabel} 正在调用 ${toolName || 'Tool'}`
    : isStarted
    ? `${targetLabel} 已开始处理`
    : `${targetLabel} 正在处理中`;
  const detail = isTool
    ? (preview || message.content)
    : !isStarted && preview
    ? preview
    : message.content;

  return (
    <div className={`mx-auto flex max-w-3xl items-center gap-3 rounded-2xl border px-4 py-3 shadow-sm ${toneClass}`}>
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-white/80 text-base shadow-sm">
        {isTool ? toolEmoji : isStderr ? '!' : '...'}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em]">
          <span>{title}</span>
          {toolName ? (
            <span className={`rounded-full px-2 py-0.5 text-[10px] normal-case tracking-normal ${pillClass}`}>
              {toolName}
            </span>
          ) : null}
          {stream ? (
            <span className={`rounded-full px-2 py-0.5 text-[10px] normal-case tracking-normal ${pillClass}`}>
              {stream}
            </span>
          ) : null}
          <span className="text-[10px] font-normal normal-case tracking-normal opacity-70">
            {new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false })}
          </span>
        </div>
        <div className="mb-2 whitespace-pre-wrap break-words text-sm leading-6">
          {detail}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-white/80">
          <div className={`h-full w-2/5 animate-pulse rounded-full ${barClass}`} />
        </div>
      </div>
    </div>
  );
};

export const getComposerModeLabel = ({
  draftMentionAll,
  draftMentionMemberIds,
  selectedTargetMemberId,
}: {
  draftMentionAll: boolean;
  draftMentionMemberIds: string[];
  selectedTargetMemberId: string;
}) => {
  if (draftMentionAll) return '$all';
  if (draftMentionMemberIds.length > 0) return 'mention';
  if (selectedTargetMemberId) return 'direct';
  return 'broadcast';
};
