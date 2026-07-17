'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ensureSocketServerReady, getSocketClient } from '@/lib/websocket-client';
import type {
  LiveRoomCatalogAgent,
  LiveRoomMessage,
  WorkspaceDetail,
  WorkspaceSummary,
} from '@/types';

interface WorkspacesResponse {
  workspaces: WorkspaceSummary[];
  availableAgents: LiveRoomCatalogAgent[];
}

type PendingReply = NonNullable<WorkspaceDetail['pendingReplies']>[number];

type MentionCandidate =
  | { kind: 'all'; id: '__all__'; label: '$all'; subtitle: string }
  | { kind: 'member'; member: WorkspaceDetail['members'][number] };

const ROOMS_PANEL_KEY = 'live-room-left-panel-open';
const DETAILS_PANEL_KEY = 'live-room-right-panel-open';
const DISABLE_LIVE_ROOM_SOCKET_AND_POLLING = true;
const MEMBER_ROLES = ['planner', 'implementer', 'reviewer', 'tester', 'researcher', 'custom'] as const;
const PERMISSION_PROFILES = ['safe_local', 'dev_local', 'full_access'] as const;
const getPermissionProfileLabel = (profile: string) =>
  profile === 'full_access' ? 'Full Access' : profile === 'dev_local' ? 'Dev Local' : 'Safe Local';

const getAgentLabel = (agent: LiveRoomCatalogAgent) =>
  `${agent.agentName || agent.label} · ${
    agent.backend === 'remote_ssh' ? `Remote SSH · ${agent.gatewayName}` : agent.gatewayName
  } / ${agent.harnessType}`;

const getMemberLabel = (member: WorkspaceDetail['members'][number]) =>
  member.memberType === 'user'
    ? member.displayName
    : `${member.displayName} · ${
        member.backend === 'platform_local'
          ? 'Platform Local'
          : member.backend === 'remote_ssh'
          ? `Remote SSH · ${member.gatewayName || 'Remote Host'}`
          : (member.gatewayName || 'Gateway')
      } / ${member.harnessType || 'agent'}`;

const getMemberSubtitle = (member: WorkspaceDetail['members'][number]) =>
  member.memberType === 'user'
    ? '你'
    : `${
        member.backend === 'platform_local'
          ? 'Platform Local'
          : member.backend === 'remote_ssh'
          ? `Remote SSH · ${member.gatewayName || 'Remote Host'}`
          : (member.gatewayName || 'Gateway')
      } / ${member.harnessType || 'agent'}`;

const getPermissionBadgeTone = (profile?: string | null) => {
  if (profile === 'full_access') return 'bg-rose-100 text-rose-700';
  if (profile === 'dev_local') return 'bg-amber-100 text-amber-700';
  if (profile === 'safe_local') return 'bg-emerald-100 text-emerald-700';
  return 'bg-slate-100 text-slate-600';
};

const getWatermarkUsageBarTone = (usageStatus?: string | null) => {
  if (usageStatus === 'high') return 'bg-amber-500';
  if (usageStatus === 'elevated') return 'bg-sky-500';
  return 'bg-slate-400';
};

const getWatermarkPolicyTone = (policyStatus?: string | null) => {
  if (policyStatus === 'critical') return 'bg-rose-100 text-rose-700';
  if (policyStatus === 'warning') return 'bg-amber-100 text-amber-700';
  return 'bg-emerald-100 text-emerald-700';
};

const getWatermarkPolicyLabel = (member: WorkspaceDetail['members'][number]) => {
  const watermark = member.contextWatermark;
  if (!watermark) {
    return null;
  }

  if (watermark.policyStatus === 'critical') return 'Reset now';
  if (watermark.policyStatus === 'warning') return 'Warning';
  return 'Within policy';
};

const getWatermarkUsageLabel = (member: WorkspaceDetail['members'][number]) => {
  const watermark = member.contextWatermark;
  if (!watermark) {
    return null;
  }

  return `Used ${watermark.usagePercentage}%`;
};

const getWatermarkTooltip = (member: WorkspaceDetail['members'][number]) => {
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

const getMentionQuery = (value: string) => value.match(/@([\w\u4e00-\u9fa5-]*)$/)?.[1] ?? '';
const hasMentionAll = (value: string) => /(^|[\s(])[@$]all\b/i.test(value);

const formatPendingAge = (seconds?: number) => {
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

const getPendingReplyStatusLabel = (reply: PendingReply) => {
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

const getWorkspaceStatusLabel = (status: WorkspaceSummary['workspaceStatus']) => {
  if (status === 'waiting_for_you') return 'waiting';
  if (status === 'failed') return 'failed';
  if (status === 'running') return 'running';
  if (status === 'archived') return 'archived';
  return 'idle';
};

const getAttentionLabel = (attentionState: WorkspaceSummary['attentionState']) => {
  if (attentionState === 'waiting_for_you') return 'needs you';
  if (attentionState === 'failed') return 'failed';
  if (attentionState === 'new_updates') return 'updates';
  return 'quiet';
};

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 80;

const getMessageMetadataValue = (message: LiveRoomMessage, key: string) =>
  (message.metadata && typeof message.metadata[key] !== 'undefined') ? message.metadata[key] : null;

const getLiveRoomSystemEvent = (message: LiveRoomMessage) => {
  const value = getMessageMetadataValue(message, 'systemEvent');
  return typeof value === 'string' ? value : null;
};

const getDirectedTargetMember = (
  message: LiveRoomMessage,
  room: WorkspaceDetail | null
) => {
  const targetMemberId = getMessageMetadataValue(message, 'primaryTargetMemberId');
  if (typeof targetMemberId !== 'string') {
    return null;
  }

  return room?.members.find((member) => member.id === targetMemberId) || null;
};

const renderLiveRoomSystemMessage = (
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

const getComposerModeLabel = ({
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

export function LiveRoomWorkspace({
  initialRoomId,
  basePath = '/workspaces',
}: {
  initialRoomId?: string;
  basePath?: string;
}) {
  const router = useRouter();
  const [rooms, setRooms] = useState<WorkspaceSummary[]>([]);
  const [availableAgents, setAvailableAgents] = useState<LiveRoomCatalogAgent[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<WorkspaceDetail | null>(null);
  const [messages, setMessages] = useState<LiveRoomMessage[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [draftMentionAll, setDraftMentionAll] = useState(false);
  const [draftMentionMemberIds, setDraftMentionMemberIds] = useState<string[]>([]);
  const [newRoomTitle, setNewRoomTitle] = useState('');
  const [newRoomTopic, setNewRoomTopic] = useState('');
  const [newRoomWorkingDirectory, setNewRoomWorkingDirectory] = useState('');
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [selectedAgentRoles, setSelectedAgentRoles] = useState<Record<string, string>>({});
  const [selectedAgentPermissions, setSelectedAgentPermissions] = useState<Record<string, string>>({});
  const [selectedTargetMemberId, setSelectedTargetMemberId] = useState('');
  const [topicDraft, setTopicDraft] = useState('');
  const [roomTitleDraft, setRoomTitleDraft] = useState('');
  const [roomDescriptionDraft, setRoomDescriptionDraft] = useState('');
  const [roomModeDraft, setRoomModeDraft] = useState('discussion');
  const [memberToAdd, setMemberToAdd] = useState('');
  const [memberRoleToAdd, setMemberRoleToAdd] = useState('custom');
  const [memberPermissionToAdd, setMemberPermissionToAdd] = useState('safe_local');
  const [isRoomsPanelOpen, setIsRoomsPanelOpen] = useState(true);
  const [isDetailsPanelOpen, setIsDetailsPanelOpen] = useState(true);
  const [isLoadingRooms, setIsLoadingRooms] = useState(true);
  const [isLoadingRoom, setIsLoadingRoom] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isSavingRoomSettings, setIsSavingRoomSettings] = useState(false);
  const [isArchivingRoom, setIsArchivingRoom] = useState(false);
  const [isDeletingRoom, setIsDeletingRoom] = useState(false);
  const [interruptingMemberId, setInterruptingMemberId] = useState<string | null>(null);
  const [openRoomActionsId, setOpenRoomActionsId] = useState<string | null>(null);
  const [showArchivedRooms, setShowArchivedRooms] = useState(false);
  const [isSocketConnected, setIsSocketConnected] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const [dismissedPendingSummary, setDismissedPendingSummary] = useState<string | null>(null);
  const messageViewportRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);

  const activeReplyMembers = useMemo(
    () => selectedRoom?.members.filter((member) => member.canReply) || [],
    [selectedRoom?.members]
  );

  const selectedSpeaker = useMemo(
    () => selectedRoom?.members.find((member) => member.id === selectedRoom.currentSpeakerMemberId) || null,
    [selectedRoom?.currentSpeakerMemberId, selectedRoom?.members]
  );

  const mentionQuery = useMemo(() => getMentionQuery(messageInput), [messageInput]);
  const activeRooms = useMemo(() => rooms.filter((room) => room.lifecycleStatus === 'active'), [rooms]);
  const archivedRooms = useMemo(() => rooms.filter((room) => room.lifecycleStatus === 'archived'), [rooms]);
  const pendingSummaryText = useMemo(() => {
    if (!selectedRoom?.pendingReplies?.length) {
      return null;
    }

    return selectedRoom.pendingReplies.map((reply) => (
      `${reply.displayName}：${getPendingReplyStatusLabel(reply)}${
        reply.lastProgressAgeSeconds != null
          ? `，最近进度 ${formatPendingAge(reply.lastProgressAgeSeconds)} 前`
          : ''
      }`
    )).join('；');
  }, [selectedRoom?.pendingReplies]);

  const mentionCandidates = useMemo(() => {
    if (!selectedRoom || !/@([\w\u4e00-\u9fa5-]*)$/.test(messageInput)) {
      return [];
    }

    const query = mentionQuery.toLowerCase();
    const memberCandidates: MentionCandidate[] = selectedRoom.members
      .filter((member) => member.canReply)
      .filter((member) => member.memberType !== 'user')
      .filter((member) => {
        if (!query) {
          return true;
        }

        return [
          member.displayName,
          member.runtimeAgentId || '',
          member.gatewayName || '',
        ].some((value) => value.toLowerCase().includes(query));
      })
      .sort((left, right) => {
        if (!query) {
          return left.sortOrder - right.sortOrder;
        }

        const leftExact = [left.runtimeAgentId || '', left.displayName].some((value) => value.toLowerCase() === query);
        const rightExact = [right.runtimeAgentId || '', right.displayName].some((value) => value.toLowerCase() === query);
        if (leftExact !== rightExact) {
          return leftExact ? -1 : 1;
        }

        const leftStartsWith = [left.runtimeAgentId || '', left.displayName].some((value) => value.toLowerCase().startsWith(query));
        const rightStartsWith = [right.runtimeAgentId || '', right.displayName].some((value) => value.toLowerCase().startsWith(query));
        if (leftStartsWith !== rightStartsWith) {
          return leftStartsWith ? -1 : 1;
        }

        return left.sortOrder - right.sortOrder;
      })
      .map((member) => ({ kind: 'member', member }));

    const allCandidate: MentionCandidate[] = !query || '$all'.includes(`$${query}`) || 'all'.includes(query)
      ? [{
          kind: 'all',
          id: '__all__',
          label: '$all',
          subtitle: `通知当前房间内全部 ${activeReplyMembers.length} 个可回复成员`,
        }]
      : [];

    return [...allCandidate, ...memberCandidates].slice(0, query ? 8 : 20);
  }, [activeReplyMembers.length, mentionQuery, messageInput, selectedRoom]);

  const refreshRooms = async ({ background = false }: { background?: boolean } = {}) => {
    if (!background) {
      setIsLoadingRooms(true);
    }

    try {
      const response = await fetch('/api/workspaces');
      const data: WorkspacesResponse = await response.json();
      setRooms(Array.isArray(data.workspaces) ? data.workspaces : []);
      setAvailableAgents(Array.isArray(data.availableAgents) ? data.availableAgents : []);
    } catch (fetchError) {
      console.error('Failed to fetch workspaces:', fetchError);
      if (!background) {
        setError('加载 workspaces 失败');
      }
    } finally {
      if (!background) {
        setIsLoadingRooms(false);
      }
    }
  };

  const refreshSelectedRoom = async (
    roomId: string,
    {
      background = false,
      preserveComposerState = false,
    }: {
      background?: boolean;
      preserveComposerState?: boolean;
    } = {}
  ) => {
    if (!background) {
      setIsLoadingRoom(true);
    }

    try {
      const [roomResponse, messagesResponse] = await Promise.all([
        fetch(`/api/workspaces/${roomId}`),
        fetch(`/api/live-rooms/${roomId}/messages?limit=120`),
      ]);
      const roomData = await roomResponse.json();
      const messagesData = await messagesResponse.json();

      if (!roomResponse.ok) {
        throw new Error(roomData.error || '加载房间详情失败');
      }

      setSelectedRoom(roomData.workspace || null);
      setMessages(Array.isArray(messagesData.messages) ? messagesData.messages : []);
      setTopicDraft(roomData.workspace?.currentTopic || '');
      setRoomTitleDraft(roomData.workspace?.title || '');
      setRoomDescriptionDraft(roomData.workspace?.description || '');
      setRoomModeDraft(roomData.workspace?.mode || 'discussion');
      if (!preserveComposerState) {
        setSelectedTargetMemberId('');
        setDraftMentionAll(false);
        setDraftMentionMemberIds([]);
      }
    } catch (fetchError) {
      console.error('Failed to fetch workspace detail:', fetchError);
      if (!background) {
        setError(fetchError instanceof Error ? fetchError.message : '加载 workspace 详情失败');
      }
    } finally {
      if (!background) {
        setIsLoadingRoom(false);
      }
    }
  };

  useEffect(() => {
    void refreshRooms();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const storedRoomsPanel = window.localStorage.getItem(ROOMS_PANEL_KEY);
    const storedDetailsPanel = window.localStorage.getItem(DETAILS_PANEL_KEY);
    setIsRoomsPanelOpen(storedRoomsPanel !== 'false');
    setIsDetailsPanelOpen(storedDetailsPanel !== 'false');
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(ROOMS_PANEL_KEY, String(isRoomsPanelOpen));
  }, [isRoomsPanelOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(DETAILS_PANEL_KEY, String(isDetailsPanelOpen));
  }, [isDetailsPanelOpen]);

  useEffect(() => {
    if (initialRoomId) {
      shouldStickToBottomRef.current = true;
      void refreshSelectedRoom(initialRoomId);
      return;
    }

    setSelectedRoom(null);
    setMessages([]);
  }, [initialRoomId]);

  useEffect(() => {
    if (!selectedRoom?.id || !selectedRoom.pendingReplyCount || selectedRoom.pendingReplyCount <= 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      void refreshSelectedRoom(selectedRoom.id, {
        background: true,
        preserveComposerState: true,
      });
      void refreshRooms({ background: true });
    }, 2000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [selectedRoom?.id, selectedRoom?.pendingReplyCount]);

  useEffect(() => {
    if (!dismissedNotice) {
      return;
    }

    if (notice !== dismissedNotice) {
      setDismissedNotice(null);
    }
  }, [dismissedNotice, notice]);

  useEffect(() => {
    if (!dismissedPendingSummary) {
      return;
    }

    if (pendingSummaryText !== dismissedPendingSummary) {
      setDismissedPendingSummary(null);
    }
  }, [dismissedPendingSummary, pendingSummaryText]);

  useEffect(() => {
    if (DISABLE_LIVE_ROOM_SOCKET_AND_POLLING) {
      setIsSocketConnected(false);
      return;
    }

    const socket = getSocketClient();
    if (!socket) {
      return;
    }

    let cancelled = false;

    const handleMessage = (message: LiveRoomMessage) => {
      if (message.roomId !== initialRoomId) {
        return;
      }

      setMessages((prev) => prev.some((item) => item.id === message.id) ? prev : [...prev, message]);
    };

    const handleRoomUpdated = (summary: WorkspaceSummary) => {
      setRooms((prev) => {
        const next = prev.some((room) => room.id === summary.id)
          ? prev.map((room) => room.id === summary.id ? summary : room)
          : [summary, ...prev];
        return [...next].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
      });

      if (summary.id === initialRoomId) {
        setSelectedRoom((current) => current && current.id === summary.id
          ? {
              ...current,
              title: summary.title,
              description: summary.description,
              currentTopic: summary.currentTopic,
              mode: summary.mode,
              status: summary.status,
              createdBy: summary.createdBy,
              createdAt: summary.createdAt,
              updatedAt: summary.updatedAt,
              currentSpeakerMemberId: summary.currentSpeakerMemberId,
              currentSpeakerName: summary.currentSpeakerName,
              memberCount: summary.memberCount,
              lastMessagePreview: summary.lastMessagePreview,
              lastMessageAt: summary.lastMessageAt,
            }
          : current);
      }
    };

    const handleRoomDeleted = ({ roomId }: { roomId: string }) => {
      setRooms((prev) => prev.filter((room) => room.id !== roomId));

      if (roomId === initialRoomId) {
        setSelectedRoom(null);
        setMessages([]);
        router.push(basePath);
      }
    };

    const handleConnect = () => {
      setIsSocketConnected(true);
    };

    const handleDisconnect = () => {
      setIsSocketConnected(false);
    };

    const connectSocket = async () => {
      await ensureSocketServerReady();
      if (cancelled) {
        return;
      }

      if (!socket.connected) {
        socket.connect();
      } else {
        setIsSocketConnected(true);
      }

      if (initialRoomId) {
        socket.emit('live-room:join', { roomId: initialRoomId });
      }

      socket.on('connect', handleConnect);
      socket.on('disconnect', handleDisconnect);
      socket.on('live-room:message', handleMessage);
      socket.on('live-room:updated', handleRoomUpdated);
      socket.on('live-room:deleted', handleRoomDeleted);
    };

    void connectSocket();

    return () => {
      cancelled = true;
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('live-room:message', handleMessage);
      socket.off('live-room:updated', handleRoomUpdated);
      socket.off('live-room:deleted', handleRoomDeleted);
    };
  }, [basePath, initialRoomId, router]);

  useEffect(() => {
    if (DISABLE_LIVE_ROOM_SOCKET_AND_POLLING) {
      return;
    }

    if (isSocketConnected) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      void refreshRooms();
      if (initialRoomId) {
        void refreshSelectedRoom(initialRoomId);
      }
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [initialRoomId, isSocketConnected]);

  useEffect(() => {
    const viewport = messageViewportRef.current;
    if (!viewport) {
      return;
    }

    if (!shouldStickToBottomRef.current) {
      return;
    }

    viewport.scrollTop = viewport.scrollHeight;
  }, [messages]);

  const handleMessageViewportScroll = () => {
    const viewport = messageViewportRef.current;
    if (!viewport) {
      return;
    }

    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    shouldStickToBottomRef.current = distanceToBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
  };

  const handleCreateRoom = async () => {
    if (!newRoomTitle.trim()) {
      setError('请先输入 workspace title');
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      const response = await fetch('/api/live-rooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: newRoomTitle.trim(),
          currentTopic: newRoomTopic.trim() || undefined,
          workingDirectory: newRoomWorkingDirectory.trim() || undefined,
          selectedAgentIds,
          selectedAgentRoles,
          selectedAgentPermissions,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '创建房间失败');
      }

      setNewRoomTitle('');
      setNewRoomTopic('');
      setNewRoomWorkingDirectory('');
      setSelectedAgentIds([]);
      setSelectedAgentRoles({});
      setSelectedAgentPermissions({});
      setNotice('新 workspace 已创建。');
      await refreshRooms();
      if (data.room?.id) {
        router.push(`${basePath}/${data.room.id}`);
      }
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建房间失败');
    } finally {
      setIsCreating(false);
    }
  };

  const handleSendMessage = async () => {
    if (!selectedRoom || !messageInput.trim()) {
      return;
    }

    shouldStickToBottomRef.current = true;
    setIsSending(true);
    setError(null);
    try {
      const hasStructuredMention = draftMentionAll || draftMentionMemberIds.length > 0;
      const visibilityMode = !hasStructuredMention && selectedTargetMemberId ? 'directed_visible' : 'room';
      const response = await fetch(`/api/live-rooms/${selectedRoom.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: messageInput.trim(),
          targetMemberId: hasStructuredMention ? undefined : (selectedTargetMemberId || undefined),
          visibilityMode,
          explicitMentionAll: draftMentionAll,
          explicitMentionMemberIds: draftMentionMemberIds,
          autoReply: true,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '发送消息失败');
      }

      const pendingReplyCount = typeof data.pendingReplyCount === 'number' ? data.pendingReplyCount : 0;
      const pendingReplyTargetNames = Array.isArray(data.pendingReplyTargetNames)
        ? data.pendingReplyTargetNames.filter((value: unknown): value is string => typeof value === 'string')
        : [];
      const pendingReplies: PendingReply[] = Array.isArray(data.pendingReplies)
        ? data.pendingReplies.filter((value: unknown): value is PendingReply => (
          Boolean(value)
          && typeof value === 'object'
          && typeof (value as PendingReply).memberId === 'string'
          && typeof (value as PendingReply).displayName === 'string'
        ))
        : [];

      setMessageInput('');
      setDraftMentionAll(false);
      setDraftMentionMemberIds([]);
      const sentNotice = draftMentionAll && selectedRoom
        ? `消息已发送，$all 会通知当前房间内全部 ${selectedRoom.members.filter((member) => member.canReply && member.memberType !== 'user').length} 个可回复成员，并按顺序回复。`
        : hasStructuredMention && selectedRoom
        ? `消息已发送，这条消息会优先按 mention 路由给 ${draftMentionMemberIds.map((memberId) => selectedRoom.members.find((member) => member.id === memberId)?.displayName).filter(Boolean).join('、')}。`
        : selectedTargetMemberId
        ? '消息已发送，这是一条房间内可见的定向消息，只有你在 dropdown 里选中的 agent 会把它当作直接输入。'
        : '消息已发送，这是一条面向整个房间的公开消息，当前 speaker 会优先接话。';
      setNotice(
        pendingReplyCount > 0
          ? `${sentNotice} 当前执行状态：${pendingReplies.length > 0
            ? pendingReplies.map((reply) => `${reply.displayName} ${getPendingReplyStatusLabel(reply)}`).join('；')
            : (pendingReplyTargetNames.join('、') || `${pendingReplyCount} 个 agent`)}。`
          : sentNotice
      );
      if (Array.isArray(data.messages)) {
        setMessages((prev) => {
          const next = [...prev];
          for (const message of data.messages as LiveRoomMessage[]) {
            if (!next.some((item) => item.id === message.id)) {
              next.push(message);
            }
          }
          return next;
        });
      } else if (data.message) {
        setMessages((prev) => prev.some((item) => item.id === data.message.id) ? prev : [...prev, data.message]);
      }
      setSelectedRoom((current) => current && current.id === selectedRoom.id
        ? {
            ...current,
            pendingReplyCount,
            pendingReplyTargetNames,
            pendingReplies,
          }
        : current);
      void refreshSelectedRoom(selectedRoom.id, {
        background: true,
        preserveComposerState: true,
      });
      void refreshRooms({ background: true });
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : '发送消息失败');
    } finally {
      setIsSending(false);
    }
  };

  const handleInterruptPendingReply = async (reply: PendingReply) => {
    if (!selectedRoom || !reply.interruptSupported) {
      return;
    }

    const confirmed = window.confirm(`确认中断 ${reply.displayName} 当前的远端回复吗？`);
    if (!confirmed) {
      return;
    }

    setInterruptingMemberId(reply.memberId);
    setError(null);

    try {
      const response = await fetch(`/api/live-rooms/${selectedRoom.id}/interrupt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          memberId: reply.memberId,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '中断远端回复失败');
      }

      const pendingReplies: PendingReply[] = Array.isArray(data.pendingReplies)
        ? data.pendingReplies.filter((value: unknown): value is PendingReply => (
          Boolean(value)
          && typeof value === 'object'
          && typeof (value as PendingReply).memberId === 'string'
          && typeof (value as PendingReply).displayName === 'string'
        ))
        : [];

      const pendingReplyTargetNames = Array.isArray(data.pendingReplyTargetNames)
        ? data.pendingReplyTargetNames.filter((value: unknown): value is string => typeof value === 'string')
        : [];
      const pendingReplyCount = typeof data.pendingReplyCount === 'number' ? data.pendingReplyCount : pendingReplies.length;

      setSelectedRoom((current) => current && current.id === selectedRoom.id
        ? {
            ...current,
            pendingReplyCount,
            pendingReplyTargetNames,
            pendingReplies,
          }
        : current);
      setNotice(
        `已请求中断 ${reply.displayName} 的远端回复。${
          typeof data.cancelledQueuedCount === 'number' && data.cancelledQueuedCount > 0
            ? ` 同时清理了 ${data.cancelledQueuedCount} 条排队消息。`
            : ''
        }`
      );
      await refreshSelectedRoom(selectedRoom.id, {
        background: true,
        preserveComposerState: true,
      });
      void refreshRooms({ background: true });
    } catch (interruptError) {
      setError(interruptError instanceof Error ? interruptError.message : '中断远端回复失败');
    } finally {
      setInterruptingMemberId(null);
    }
  };

  const handleUpdateTopic = async () => {
    if (!selectedRoom) {
      return;
    }

    setError(null);
    try {
      const response = await fetch(`/api/live-rooms/${selectedRoom.id}/topic`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          topic: topicDraft,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '更新 topic 失败');
      }
      setNotice('Topic 已更新。');
      await refreshSelectedRoom(selectedRoom.id);
      await refreshRooms();
    } catch (topicError) {
      setError(topicError instanceof Error ? topicError.message : '更新 topic 失败');
    }
  };

  const handleSaveRoomSettings = async () => {
    if (!selectedRoom) {
      return;
    }

    if (!roomTitleDraft.trim()) {
      setError('请先输入 workspace title');
      return;
    }

    setIsSavingRoomSettings(true);
    setError(null);

    try {
      const response = await fetch(`/api/live-rooms/${selectedRoom.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: roomTitleDraft.trim(),
          description: roomDescriptionDraft,
          mode: roomModeDraft,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '更新房间设置失败');
      }

      setNotice('房间设置已更新。');
      await refreshSelectedRoom(selectedRoom.id);
      await refreshRooms();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '更新房间设置失败');
    } finally {
      setIsSavingRoomSettings(false);
    }
  };

  const handleOpenRoomSettingsFromList = async (roomId: string) => {
    setOpenRoomActionsId(null);
    setIsDetailsPanelOpen(true);

    if (selectedRoom?.id === roomId) {
      await refreshSelectedRoom(roomId);
      return;
    }

    router.push(`${basePath}/${roomId}`);
  };

  const handleArchiveRoomById = async (roomId: string, roomTitle: string) => {
    const confirmed = window.confirm(`确认归档房间 "${roomTitle}" 吗？归档后它会从当前房间列表中隐藏。`);
    if (!confirmed) {
      return;
    }

    setOpenRoomActionsId(null);
    setIsArchivingRoom(true);
    setError(null);

    try {
      const response = await fetch(`/api/live-rooms/${roomId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: 'archived',
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '归档房间失败');
      }

      setNotice(`房间已归档：${roomTitle}`);
      if (selectedRoom?.id === roomId) {
        await refreshSelectedRoom(roomId);
      }
      await refreshRooms();
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : '归档房间失败');
    } finally {
      setIsArchivingRoom(false);
    }
  };

  const handleArchiveRoom = async () => {
    if (!selectedRoom) {
      return;
    }

    await handleArchiveRoomById(selectedRoom.id, selectedRoom.title);
  };

  const handleHardDeleteRoom = async () => {
    if (!selectedRoom) {
      return;
    }

    const confirmed = window.confirm(`确认永久删除房间 "${selectedRoom.title}" 吗？这会删除消息、成员和相关记录，且不可恢复。`);
    if (!confirmed) {
      return;
    }

    setOpenRoomActionsId(null);
    setIsDeletingRoom(true);
    setError(null);

    try {
      const response = await fetch(`/api/live-rooms/${selectedRoom.id}?hard=true`, {
        method: 'DELETE',
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '永久删除房间失败');
      }

      setNotice(`房间已永久删除：${selectedRoom.title}`);
      setSelectedRoom(null);
      setMessages([]);
      setTopicDraft('');
      setRoomTitleDraft('');
      setRoomDescriptionDraft('');
      setRoomModeDraft('discussion');
      await refreshRooms();
      router.push(basePath);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '永久删除房间失败');
    } finally {
      setIsDeletingRoom(false);
    }
  };

  const handleHardDeleteRoomById = async (roomId: string, roomTitle: string) => {
    if (selectedRoom?.id === roomId) {
      await handleHardDeleteRoom();
      return;
    }

    const confirmed = window.confirm(`确认永久删除房间 "${roomTitle}" 吗？这会删除消息、成员和相关记录，且不可恢复。`);
    if (!confirmed) {
      return;
    }

    setOpenRoomActionsId(null);
    setIsDeletingRoom(true);
    setError(null);

    try {
      const response = await fetch(`/api/live-rooms/${roomId}?hard=true`, {
        method: 'DELETE',
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '永久删除房间失败');
      }

      setNotice(`房间已永久删除：${roomTitle}`);
      await refreshRooms();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '永久删除房间失败');
    } finally {
      setIsDeletingRoom(false);
    }
  };

  const handleAddMember = async () => {
    if (!selectedRoom || !memberToAdd) {
      return;
    }

    try {
      const response = await fetch(`/api/live-rooms/${selectedRoom.id}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agentId: memberToAdd,
          role: memberRoleToAdd,
          permissionProfile: memberPermissionToAdd,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '添加成员失败');
      }
      setMemberToAdd('');
      setMemberRoleToAdd('custom');
      setMemberPermissionToAdd('safe_local');
      setNotice(data.duplicate ? '该 agent 已在房间里。' : '成员已加入房间。');
      await refreshSelectedRoom(selectedRoom.id);
      await refreshRooms();
    } catch (memberError) {
      setError(memberError instanceof Error ? memberError.message : '添加成员失败');
    }
  };

  const handleUpdateMemberRole = async (memberId: string, role: string) => {
    if (!selectedRoom) return;

    const response = await fetch(`/api/live-rooms/${selectedRoom.id}/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || '更新成员角色失败');
      return;
    }
    setNotice('成员角色已更新。');
    await refreshSelectedRoom(selectedRoom.id);
  };

  const handleUpdateMemberPermission = async (memberId: string, permissionProfile: string) => {
    if (!selectedRoom) return;

    const response = await fetch(`/api/live-rooms/${selectedRoom.id}/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionProfile }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || '更新成员权限失败');
      return;
    }
    setNotice('成员权限已更新，将在下一次 run / continuation 生效。');
    await refreshSelectedRoom(selectedRoom.id);
  };

  const handleSetSpeaker = async (memberId: string) => {
    if (!selectedRoom) {
      return;
    }

    try {
      const response = await fetch(`/api/live-rooms/${selectedRoom.id}/speaker`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          memberId,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '切换 speaker 失败');
      }
      setSelectedTargetMemberId('');
      setNotice('当前主回复 agent 已切换。');
      await refreshSelectedRoom(selectedRoom.id);
      await refreshRooms();
    } catch (speakerError) {
      setError(speakerError instanceof Error ? speakerError.message : '切换 speaker 失败');
    }
  };

  const addableAgents = useMemo(() => {
    const existingIds = new Set(
      selectedRoom?.members.map((member) => `${member.backend}:${member.gatewayId || 'platform-local'}:${member.runtimeAgentId || member.displayName}`) || []
    );

    return availableAgents.filter((agent) => !existingIds.has(
      `${agent.backend}:${agent.gatewayId}:${agent.runtimeAgentId || agent.agentName || agent.label}`
    ));
  }, [availableAgents, selectedRoom?.members]);

  const layoutClass = useMemo(() => {
    if (isRoomsPanelOpen && isDetailsPanelOpen) {
      return 'grid-cols-[280px,minmax(0,1fr),320px]';
    }
    if (isRoomsPanelOpen) {
      return 'grid-cols-[280px,minmax(0,1fr)]';
    }
    if (isDetailsPanelOpen) {
      return 'grid-cols-[minmax(0,1fr),320px]';
    }
    return 'grid-cols-[minmax(0,1fr)]';
  }, [isDetailsPanelOpen, isRoomsPanelOpen]);

  const handlePickMention = (candidate: MentionCandidate) => {
    if (candidate.kind === 'all') {
      setMessageInput((prev) => prev.replace(/[@$]([\w\u4e00-\u9fa5-]*)$/, '$all '));
      setDraftMentionAll(true);
      setDraftMentionMemberIds([]);
      return;
    }

    setMessageInput((prev) => prev.replace(/@([\w\u4e00-\u9fa5-]*)$/, `@${candidate.member.displayName} `));
    setDraftMentionAll(false);
    setDraftMentionMemberIds((prev) => Array.from(new Set([...prev, candidate.member.id])));
  };

  const handleComposerChange = (value: string) => {
    setMessageInput(value);
    setDraftMentionAll(hasMentionAll(value));
    setDraftMentionMemberIds((prev) => {
      if (!selectedRoom) {
        return prev;
      }

      return prev.filter((memberId) => {
        const member = selectedRoom.members.find((item) => item.id === memberId);
        if (!member) {
          return false;
        }

        return value.toLowerCase().includes(`@${member.displayName}`.toLowerCase());
      });
    });
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSendMessage();
    }
  };

  return (
    <div className={`grid h-[calc(100vh-4rem)] min-h-[780px] overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.08)] ${layoutClass}`}>
      {isRoomsPanelOpen ? (
        <aside className="flex min-h-0 flex-col border-r border-slate-200 bg-[#f7f7f8]">
          <div className="border-b border-slate-200 px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Workspaces</div>
                <div className="mt-2 text-lg font-semibold text-slate-900">项目工作空间</div>
              </div>
              <button
                onClick={() => setIsRoomsPanelOpen(false)}
                className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
              >
                隐藏
              </button>
            </div>
          </div>

          <div className="border-b border-slate-200 px-4 py-4">
            <div className="text-sm font-medium text-slate-900">新建 Workspace</div>
            <input
              value={newRoomTitle}
              onChange={(event) => setNewRoomTitle(event.target.value)}
              placeholder="例如：跨网关 OCR 工作空间"
              className="mt-3 w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none ring-0 transition focus:border-slate-500"
            />
            <textarea
              value={newRoomTopic}
              onChange={(event) => setNewRoomTopic(event.target.value)}
              rows={2}
              placeholder="给这个 workspace 一个当前 topic / task..."
              className="mt-2 w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none ring-0 transition focus:border-slate-500"
            />
            <input
              value={newRoomWorkingDirectory}
              onChange={(event) => setNewRoomWorkingDirectory(event.target.value)}
              placeholder="工作目录，例如 /data1/code/defects-detection"
              className="mt-2 w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none ring-0 transition focus:border-slate-500"
            />
            <div className="mt-2 max-h-36 space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-2">
              {availableAgents.map((agent) => {
                const checked = selectedAgentIds.includes(agent.id);
                return (
                  <div key={agent.id} className="flex items-start gap-2 rounded-xl px-2 py-1.5 hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelectedAgentIds((prev) => checked
                          ? prev.filter((item) => item !== agent.id)
                          : [...prev, agent.id]
                        )
                      }
                      className="mt-1"
                    />
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-slate-800">{agent.agentName || agent.label}</div>
                      <div className="text-[11px] text-slate-500">{agent.gatewayName} / {agent.harnessType}</div>
                    </div>
                    {checked ? (
                      <div className="ml-auto flex gap-1">
                        <select
                          value={selectedAgentRoles[agent.id] || 'custom'}
                          onChange={(event) => setSelectedAgentRoles((roles) => ({ ...roles, [agent.id]: event.target.value }))}
                          className="rounded-lg border border-slate-300 px-2 py-1 text-[11px]"
                        >
                          {MEMBER_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                        </select>
                        <select
                          value={selectedAgentPermissions[agent.id] || 'safe_local'}
                          onChange={(event) => setSelectedAgentPermissions((permissions) => ({ ...permissions, [agent.id]: event.target.value }))}
                          className="rounded-lg border border-slate-300 px-2 py-1 text-[11px]"
                        >
                          {PERMISSION_PROFILES.map((profile) => (
                            <option key={profile} value={profile}>{getPermissionProfileLabel(profile)}</option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <button
              onClick={() => void handleCreateRoom()}
              disabled={isCreating}
              className="mt-3 w-full rounded-full bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:bg-slate-400"
            >
              {isCreating ? '创建中...' : '创建 Workspace'}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
            {isLoadingRooms ? (
              <div className="px-3 py-4 text-sm text-slate-500">加载 workspaces 中...</div>
            ) : rooms.length === 0 ? (
              <div className="px-3 py-4 text-sm text-slate-500">还没有 workspace，先创建一个。</div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1">
                  {activeRooms.map((room) => {
                    const isActive = room.id === selectedRoom?.id || room.id === initialRoomId;
                    return (
                      <div
                        key={room.id}
                        className={`relative rounded-2xl px-3 py-3 transition ${
                          isActive ? 'bg-white shadow-sm ring-1 ring-slate-200' : 'hover:bg-white/70'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <Link
                            href={`${basePath}/${room.id}`}
                            className="min-w-0 flex-1"
                          >
                            <div className="truncate text-sm font-medium text-slate-900">{room.title}</div>
                            <div className="mt-1 truncate text-xs text-slate-500">{room.currentTopic || '暂未设置 topic'}</div>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-700">
                                {getWorkspaceStatusLabel(room.workspaceStatus)}
                              </span>
                              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                                {getAttentionLabel(room.attentionState)}
                              </span>
                              {room.linkedChannels.some((channel) => channel.kind === 'feishu_chat') ? (
                                <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700">
                                  Feishu
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-400">
                              <span>{room.memberCount} members</span>
                              <span className="truncate">{room.currentSpeakerName || '无 speaker'}</span>
                            </div>
                          </Link>
                          <div className="relative shrink-0">
                            <button
                              type="button"
                              onClick={() =>
                                setOpenRoomActionsId((current) => current === room.id ? null : room.id)
                              }
                              className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
                              aria-label={`Open actions for ${room.title}`}
                            >
                              ...
                            </button>
                            {openRoomActionsId === room.id ? (
                              <div className="absolute right-0 top-10 z-10 w-40 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-lg">
                                <button
                                  type="button"
                                  onClick={() => void handleOpenRoomSettingsFromList(room.id)}
                                  className="block w-full rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleArchiveRoomById(room.id, room.title)}
                                  disabled={isArchivingRoom}
                                  className="block w-full rounded-xl px-3 py-2 text-left text-sm text-rose-700 transition hover:bg-rose-50 disabled:text-rose-300"
                                >
                                  Archive
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white/60">
                  <button
                    type="button"
                    onClick={() => setShowArchivedRooms((current) => !current)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left"
                  >
                    <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                      Archived Workspaces
                    </span>
                    <span className="text-xs text-slate-500">
                      {archivedRooms.length} {showArchivedRooms ? 'hide' : 'show'}
                    </span>
                  </button>
                  {showArchivedRooms ? (
                    archivedRooms.length === 0 ? (
                      <div className="px-3 pb-3 text-sm text-slate-500">还没有 archived workspaces。</div>
                    ) : (
                      <div className="space-y-1 px-2 pb-2">
                        {archivedRooms.map((room) => {
                          const isActive = room.id === selectedRoom?.id || room.id === initialRoomId;
                          return (
                            <div
                              key={room.id}
                              className={`relative rounded-2xl px-3 py-3 transition ${
                                isActive ? 'bg-white shadow-sm ring-1 ring-slate-200' : 'hover:bg-white/70'
                              }`}
                            >
                              <div className="flex items-start gap-2">
                                <Link
                                  href={`${basePath}/${room.id}`}
                                  className="min-w-0 flex-1"
                                >
                                  <div className="truncate text-sm font-medium text-slate-700">{room.title}</div>
                                  <div className="mt-1 truncate text-xs text-slate-500">{room.currentTopic || '暂未设置 topic'}</div>
                                  <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-400">
                                    <span>{room.memberCount} members</span>
                                    <span className="truncate">archived</span>
                                  </div>
                                </Link>
                                <div className="relative shrink-0">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setOpenRoomActionsId((current) => current === room.id ? null : room.id)
                                    }
                                    className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
                                    aria-label={`Open actions for ${room.title}`}
                                  >
                                    ...
                                  </button>
                                  {openRoomActionsId === room.id ? (
                                    <div className="absolute right-0 top-10 z-10 w-44 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-lg">
                                      <button
                                        type="button"
                                        onClick={() => void handleOpenRoomSettingsFromList(room.id)}
                                        className="block w-full rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                                      >
                                        Edit
                                      </button>
                                      <button
                                        type="button"
                                        disabled
                                        className="block w-full rounded-xl px-3 py-2 text-left text-sm text-slate-300"
                                      >
                                        Archived
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => void handleHardDeleteRoomById(room.id, room.title)}
                                        disabled={isDeletingRoom}
                                        className="block w-full rounded-xl px-3 py-2 text-left text-sm text-rose-700 transition hover:bg-rose-50 disabled:text-rose-300"
                                      >
                                        Delete Permanently
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </aside>
      ) : null}

      <section className="grid min-h-0 grid-rows-[auto,minmax(0,1fr),auto] bg-[#fcfcfd]">
        {!selectedRoom && !initialRoomId ? (
          <div className="flex h-full items-center justify-center px-10">
            <div className="max-w-2xl text-center">
              <div className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">Workspace</div>
              <h1 className="mt-4 text-4xl font-semibold text-slate-900">像 Codex Desktop 一样进入持续协作项目</h1>
              <p className="mt-4 text-base leading-7 text-slate-600">
                先创建 workspace、邀请来自任意 gateway 的 agent，然后在中间持续推进 topic。
                这里的主语义是项目、线程和同步入口，不再只是 run 控制台。
              </p>
              {!isRoomsPanelOpen ? (
                <button
                  onClick={() => setIsRoomsPanelOpen(true)}
                  className="mt-6 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  显示 Workspaces
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            <header className="border-b border-slate-200 bg-white px-6 py-3">
              <div className="flex items-start justify-between gap-6">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Workspace Thread</div>
                  <div className="mt-1 flex flex-wrap items-center gap-3">
                    <h1 className="truncate text-[24px] font-semibold text-slate-950">{selectedRoom?.title || '加载中...'}</h1>
                    <span className="max-w-full truncate text-sm text-slate-600">
                      topic: {selectedRoom?.currentTopic || '未设置'}
                    </span>
                    <span className="max-w-full truncate text-sm text-slate-600">
                      speaker: {selectedSpeaker ? getMemberLabel(selectedSpeaker) : '未选择'}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="rounded-full bg-slate-100 px-3 py-1">{selectedRoom?.mode || 'discussion'}</span>
                  <span className="rounded-full bg-slate-100 px-3 py-1">{selectedRoom?.memberCount || 0} members</span>
                  {selectedRoom ? (
                    <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">
                      {getAttentionLabel(selectedRoom.attentionState)}
                    </span>
                  ) : null}
                  {selectedRoom?.linkedChannels.some((channel) => channel.kind === 'feishu_chat') ? (
                    <span className="rounded-full bg-sky-50 px-3 py-1 text-sky-700">
                      Feishu linked
                    </span>
                  ) : null}
                  {!isRoomsPanelOpen ? (
                    <button
                      onClick={() => setIsRoomsPanelOpen(true)}
                      className="rounded-full border border-slate-300 bg-white px-3 py-1 font-medium text-slate-600 transition hover:bg-slate-50"
                    >
                      显示 Workspaces
                    </button>
                  ) : null}
                  {!isDetailsPanelOpen ? (
                    <button
                      onClick={() => setIsDetailsPanelOpen(true)}
                      className="rounded-full border border-slate-300 bg-white px-3 py-1 font-medium text-slate-600 transition hover:bg-slate-50"
                    >
                      显示详情
                    </button>
                  ) : null}
                </div>
              </div>
            </header>

            <div
              ref={messageViewportRef}
              onScroll={handleMessageViewportScroll}
              className="min-h-0 overflow-y-auto px-5 py-3"
            >
              {isLoadingRoom ? (
                <div className="text-sm text-slate-500">加载房间内容中...</div>
              ) : messages.length === 0 ? (
                <div className="mx-auto max-w-3xl rounded-[28px] border border-dashed border-slate-300 bg-white px-8 py-12 text-center text-sm text-slate-500">
                  这间房还没有消息。先设定一个 topic，然后从底部开始对话。
                </div>
              ) : (
                <div className="mx-auto flex max-w-4xl flex-col gap-3 pb-1">
                  {messages.map((message) => {
                    const isUser = message.senderType === 'user';
                    const isAssistant = message.messageType === 'assistant';
                    const isSystem = message.messageType === 'system' || message.messageType === 'topic';
                    const deliveryIntent = getMessageMetadataValue(message, 'deliveryIntent');
                    const isDirectedVisible = deliveryIntent === 'directed_visible' || message.visibility === 'directed_visible';
                    const directedTargetMember = getDirectedTargetMember(message, selectedRoom);

                    if (isSystem) {
                      const customSystemMessage = renderLiveRoomSystemMessage(message, selectedRoom);
                      if (customSystemMessage) {
                        return <div key={message.id}>{customSystemMessage}</div>;
                      }

                      return (
                        <div key={message.id} className="mx-auto max-w-2xl rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-800">
                          {message.content}
                        </div>
                      );
                    }

                    return (
                      <div key={message.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[82%] rounded-[24px] px-4 py-3 shadow-sm ${
                          isUser
                            ? 'bg-[#111827] text-white'
                            : isAssistant
                            ? 'bg-white text-slate-900 ring-1 ring-slate-200'
                            : 'bg-slate-100 text-slate-900'
                        }`}>
                          <div className={`mb-1 flex flex-wrap items-center gap-1.5 text-[10px] ${isUser ? 'text-slate-300' : 'text-slate-500'}`}>
                            <span>
                              {message.senderLabel || message.senderName}
                              {isDirectedVisible && directedTargetMember ? ` -> ${directedTargetMember.displayName}` : ''}
                            </span>
                            <span>· {new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                          </div>
                          {Array.isArray(getMessageMetadataValue(message, 'mentionedMemberIds')) || getMessageMetadataValue(message, 'primaryTargetMemberId') || getMessageMetadataValue(message, 'mentionedAll') ? (
                            <div className="mb-2 flex flex-wrap gap-1.5">
                              {typeof deliveryIntent === 'string' ? (
                                <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                                  isUser ? 'bg-white/10 text-slate-200' : 'bg-slate-100 text-slate-600'
                                }`}>
                                  {String(deliveryIntent)}
                                </span>
                              ) : null}
                              {isDirectedVisible ? (
                                <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                                  isUser ? 'bg-emerald-400/20 text-emerald-100' : 'bg-emerald-100 text-emerald-700'
                                }`}>
                                  room-visible direct
                                </span>
                              ) : null}
                              {getMessageMetadataValue(message, 'mentionedAll') ? (
                                <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                                  isUser ? 'bg-white/10 text-slate-200' : 'bg-slate-100 text-slate-600'
                                }`}>
                                  $all
                                </span>
                              ) : null}
                              {Array.isArray(getMessageMetadataValue(message, 'expectedResponderMemberIds'))
                                && getMessageMetadataValue(message, 'mentionedAll') ? (
                                <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                                  isUser ? 'bg-white/10 text-slate-200' : 'bg-slate-100 text-slate-600'
                                }`}>
                                  queued: {(getMessageMetadataValue(message, 'expectedResponderMemberIds') as unknown[]).length}
                                </span>
                              ) : null}
                              {selectedRoom?.members
                                .filter((member) => member.id === getMessageMetadataValue(message, 'primaryTargetMemberId'))
                                .map((member) => (
                                  <span
                                    key={`${message.id}:${member.id}:primary`}
                                    className={`rounded-full px-2 py-0.5 text-[10px] ${
                                      isUser ? 'bg-white/10 text-slate-200' : 'bg-slate-100 text-slate-600'
                                    }`}
                                  >
                                    target: {member.displayName}
                                  </span>
                                ))}
                              {selectedRoom?.members
                                .filter((member) => {
                                  const mentionedMemberIds = getMessageMetadataValue(message, 'mentionedMemberIds');
                                  return Array.isArray(mentionedMemberIds) && mentionedMemberIds.includes(member.id);
                                })
                                .map((member) => (
                                  <span
                                    key={`${message.id}:${member.id}`}
                                    className={`rounded-full px-2 py-0.5 text-[10px] ${
                                      isUser ? 'bg-white/10 text-slate-200' : 'bg-slate-100 text-slate-600'
                                    }`}
                                  >
                                    @{member.displayName}
                                  </span>
                                ))}
                            </div>
                          ) : null}
                          <div className="whitespace-pre-wrap break-words text-[14px] leading-6">
                            {message.content}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="border-t border-slate-200 bg-white px-6 py-2.5">
              <div className="mx-auto max-w-4xl rounded-[22px] border border-slate-200 bg-white px-4 py-2.5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <select
                    value={selectedTargetMemberId}
                    onChange={(event) => setSelectedTargetMemberId(event.target.value)}
                    className="rounded-full border border-slate-300 px-3 py-1.5 text-xs text-slate-700"
                  >
                    <option value="">向整个房间说话（由当前 speaker 优先回应）</option>
                    {activeReplyMembers.map((member) => (
                      <option key={member.id} value={member.id}>
                        {getMemberLabel(member)}
                      </option>
                    ))}
                  </select>
                  <div className="rounded-full bg-slate-100 px-3 py-1.5 text-xs text-slate-600">
                    {draftMentionAll
                      ? '这条消息带有 $all，当前房间内所有可回复成员都会收到并按顺序回应。'
                      : draftMentionMemberIds.length > 0
                      ? '这条消息包含结构化 mention，本次会优先按 mention 路由。'
                      : selectedTargetMemberId
                      ? '这是一条房间可见的定向消息，只有 dropdown 里选中的 agent 会把它作为直接输入。'
                      : '这是一条面向整个房间的公开消息，当前 speaker 会优先回复。'}
                  </div>
                </div>
                <textarea
                  value={messageInput}
                  onChange={(event) => handleComposerChange(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  rows={1}
                  placeholder="向房间继续说点什么，可以直接 @agent 或点名某个 agent..."
                  className="min-h-[44px] w-full resize-none border-0 bg-transparent px-1 py-0.5 text-[14px] text-slate-900 outline-none"
                />
                {mentionCandidates.length > 0 ? (
                  <div className="mt-2 rounded-2xl border border-slate-200 bg-slate-50 p-2">
                    <div className="mb-1 px-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">Mention</div>
                    <div className="space-y-1">
                      {mentionCandidates.map((member) => (
                        <button
                          key={member.kind === 'all' ? member.id : member.member.id}
                          onClick={() => handlePickMention(member)}
                          onMouseDown={(event) => event.preventDefault()}
                          className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left transition hover:bg-white"
                          type="button"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-slate-800">
                              {member.kind === 'all' ? member.label : member.member.displayName}
                            </div>
                            <div className="truncate text-[11px] text-slate-500">
                              {member.kind === 'all' ? member.subtitle : getMemberSubtitle(member.member)}
                            </div>
                          </div>
                          <span className="rounded-full bg-white px-2 py-1 text-[10px] text-slate-500">
                            {member.kind === 'all' ? '$all' : `$${member.member.displayName}`}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="mt-1.5 flex items-center justify-between gap-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-600">
                      mode: {getComposerModeLabel({
                        draftMentionAll,
                        draftMentionMemberIds,
                        selectedTargetMemberId,
                      })}
                    </span>
                    {draftMentionAll && selectedRoom
                      ? `已结构化 mention：$all（${selectedRoom.members.filter((member) => member.canReply && member.memberType !== 'user').length} 个可回复成员）`
                      : draftMentionMemberIds.length > 0 && selectedRoom
                      ? `已结构化 mention：${draftMentionMemberIds.map((memberId) => selectedRoom.members.find((member) => member.id === memberId)?.displayName).filter(Boolean).join('、')}`
                      : selectedSpeaker
                      ? `当前主回复 agent：${getMemberLabel(selectedSpeaker)}`
                      : '还没有 speaker，先在右侧选择一个可回复成员。'}
                    {selectedRoom?.pendingReplies?.length
                      ? ` 正在等待：${selectedRoom.pendingReplies.map((reply) => (
                        `${reply.displayName} (${getPendingReplyStatusLabel(reply)})`
                      )).join('、')}`
                      : selectedRoom?.pendingReplyCount
                      ? ` 正在等待：${(selectedRoom.pendingReplyTargetNames || []).join('、') || `${selectedRoom.pendingReplyCount} 个 agent`}`
                      : ''}
                  </div>
                  <button
                    onClick={() => void handleSendMessage()}
                    disabled={isSending || !messageInput.trim()}
                    className="rounded-full bg-slate-900 px-5 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:bg-slate-400"
                  >
                    {isSending ? '发送中...' : '发送'}
                  </button>
                </div>
              </div>
              {notice && notice !== dismissedNotice ? (
                <div className="mx-auto mt-2 flex max-w-4xl items-start justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-700">
                  <div className="min-w-0 flex-1">{notice}</div>
                  <button
                    type="button"
                    onClick={() => setDismissedNotice(notice)}
                    className="shrink-0 rounded-full border border-emerald-300 bg-white px-2 py-0.5 text-[11px] font-medium text-emerald-700 transition hover:bg-emerald-100"
                    aria-label="Dismiss notice"
                  >
                    x
                  </button>
                </div>
              ) : null}
              {pendingSummaryText && pendingSummaryText !== dismissedPendingSummary ? (
                <div className="mx-auto mt-2 flex max-w-4xl items-start justify-between gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-2 text-xs text-sky-700">
                  <div className="min-w-0 flex-1">
                    <div>{pendingSummaryText}。页面会轻量自动刷新。</div>
                    {selectedRoom?.pendingReplies?.some((reply) => reply.interruptSupported && reply.runningCount > 0) ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {selectedRoom.pendingReplies
                          .filter((reply) => reply.interruptSupported && reply.runningCount > 0)
                          .map((reply) => (
                            <button
                              key={`interrupt:${reply.memberId}`}
                              type="button"
                              onClick={() => void handleInterruptPendingReply(reply)}
                              disabled={interruptingMemberId === reply.memberId}
                              className="rounded-full border border-sky-300 bg-white px-3 py-1 text-[11px] font-medium text-sky-700 transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:text-sky-400"
                            >
                              {interruptingMemberId === reply.memberId
                                ? `中断 ${reply.displayName} 中...`
                                : `中断 ${reply.displayName}`}
                            </button>
                          ))}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setDismissedPendingSummary(pendingSummaryText)}
                    className="shrink-0 rounded-full border border-sky-300 bg-white px-2 py-0.5 text-[11px] font-medium text-sky-700 transition hover:bg-sky-100"
                    aria-label="Dismiss pending summary"
                  >
                    x
                  </button>
                </div>
              ) : null}
              {error ? (
                <div className="mx-auto mt-2 max-w-4xl rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">
                  {error}
                </div>
              ) : null}
            </div>
          </>
        )}
      </section>

      {isDetailsPanelOpen ? (
        <aside className="min-h-0 overflow-y-auto border-l border-slate-200 bg-[#fafafa] px-5 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Room Details</div>
            <button
              onClick={() => setIsDetailsPanelOpen(false)}
              className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
            >
              隐藏
            </button>
          </div>
          {!selectedRoom ? (
            <div className="mt-4 text-sm text-slate-500">选择或创建一个房间后，这里会显示 topic、speaker 和成员信息。</div>
          ) : (
            <div className="space-y-5">
              <section className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
                <div className="text-sm font-medium text-slate-900">房间设置</div>
                <div className="mt-3 space-y-3">
                  <label className="block">
                    <div className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-slate-400">Title</div>
                    <input
                      value={roomTitleDraft}
                      onChange={(event) => setRoomTitleDraft(event.target.value)}
                      className="w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
                    />
                  </label>
                  <label className="block">
                    <div className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-slate-400">Description</div>
                    <textarea
                      value={roomDescriptionDraft}
                      onChange={(event) => setRoomDescriptionDraft(event.target.value)}
                      rows={3}
                      className="w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
                    />
                  </label>
                  <label className="block">
                    <div className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-slate-400">Mode</div>
                    <select
                      value={roomModeDraft}
                      onChange={(event) => setRoomModeDraft(event.target.value)}
                      className="w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
                    >
                      <option value="discussion">discussion</option>
                      <option value="execution">execution</option>
                      <option value="hybrid">hybrid</option>
                    </select>
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => void handleSaveRoomSettings()}
                    disabled={isSavingRoomSettings}
                    className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:text-slate-400"
                  >
                    {isSavingRoomSettings ? '保存中...' : '保存房间设置'}
                  </button>
                  <button
                    onClick={() => void handleArchiveRoom()}
                    disabled={isArchivingRoom}
                    className="rounded-full border border-rose-300 bg-white px-4 py-2 text-xs font-medium text-rose-700 transition hover:bg-rose-50 disabled:text-rose-300"
                  >
                    {isArchivingRoom ? '归档中...' : '归档房间'}
                  </button>
                  {selectedRoom.status === 'archived' ? (
                    <button
                      onClick={() => void handleHardDeleteRoom()}
                      disabled={isDeletingRoom}
                      className="rounded-full border border-rose-500 bg-rose-50 px-4 py-2 text-xs font-medium text-rose-800 transition hover:bg-rose-100 disabled:text-rose-300"
                    >
                      {isDeletingRoom ? '删除中...' : '永久删除'}
                    </button>
                  ) : null}
                </div>
              </section>

              <section className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
                <div className="text-sm font-medium text-slate-900">当前 Topic</div>
                <textarea
                  value={topicDraft}
                  onChange={(event) => setTopicDraft(event.target.value)}
                  rows={4}
                  className="mt-3 w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
                />
                <button
                  onClick={() => void handleUpdateTopic()}
                  className="mt-3 rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  保存 Topic
                </button>
              </section>

              <section className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
                <div className="text-sm font-medium text-slate-900">当前 Speaker</div>
                <div className="mt-3 space-y-2">
                  {activeReplyMembers.map((member) => {
                    const isActive = member.id === selectedRoom.currentSpeakerMemberId;
                    return (
                      <button
                        key={member.id}
                        onClick={() => void handleSetSpeaker(member.id)}
                        className={`flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left transition ${
                          isActive ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-800 hover:bg-slate-100'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{member.displayName}</div>
                          <div className={`mt-0.5 text-[11px] ${isActive ? 'text-slate-300' : 'text-slate-500'}`}>
                            {getMemberSubtitle(member)}
                          </div>
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] ${isActive ? 'bg-white/10 text-white' : 'bg-white text-slate-500'}`}>
                          {member.presenceStatus}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-slate-900">房间成员</div>
                  <a
                    href="/agents"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
                  >
                    管理昵称 →
                  </a>
                </div>
                <div className="mt-3 space-y-2">
                  {selectedRoom.members.map((member) => (
                    <div key={member.id} className="rounded-2xl bg-slate-50 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate text-sm font-medium text-slate-800">{member.displayName}</div>
                        <div className="flex shrink-0 items-center gap-2">
                          {member.permissionLabel ? (
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${getPermissionBadgeTone(member.permissionProfile)}`}>
                              {member.permissionLabel}
                            </span>
                          ) : null}
                          {member.contextWatermark ? (
                            <>
                              <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-slate-600">
                                {getWatermarkUsageLabel(member)}
                              </span>
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${getWatermarkPolicyTone(member.contextWatermark.policyStatus)}`}>
                                {getWatermarkPolicyLabel(member)}
                              </span>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500">
                        {getMemberSubtitle(member)}
                      </div>
                      {member.memberType !== 'user' ? (
                        <div className="mt-2 flex gap-2">
                          <select
                            value={member.role}
                            onChange={(event) => void handleUpdateMemberRole(member.id, event.target.value)}
                            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px]"
                          >
                            {MEMBER_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                          </select>
                          <select
                            value={member.permissionProfile || 'safe_local'}
                            onChange={(event) => void handleUpdateMemberPermission(member.id, event.target.value)}
                            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px]"
                          >
                            {PERMISSION_PROFILES.map((profile) => (
                              <option key={profile} value={profile}>{getPermissionProfileLabel(profile)}</option>
                            ))}
                          </select>
                        </div>
                      ) : null}
                      {member.contextWatermark ? (
                        <div className="mt-2" title={getWatermarkTooltip(member)}>
                          <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
                            <div
                              className={`h-full rounded-full ${getWatermarkUsageBarTone(member.contextWatermark.usageStatus)}`}
                              style={{ width: `${Math.min(100, Math.max(0, member.contextWatermark.usagePercentage))}%` }}
                            />
                          </div>
                          <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
                            <span>{getWatermarkUsageLabel(member)}</span>
                            <span>{member.contextWatermark.dominantLabel}</span>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>

                <div className="mt-4 border-t border-slate-200 pt-4">
                  <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">Add Member</div>
                  <select
                    value={memberToAdd}
                    onChange={(event) => setMemberToAdd(event.target.value)}
                    className="mt-3 w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
                  >
                    <option value="">选择一个可加入的 agent</option>
                    {addableAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {getAgentLabel(agent)}
                      </option>
                    ))}
                  </select>
                  <select
                    value={memberRoleToAdd}
                    onChange={(event) => setMemberRoleToAdd(event.target.value)}
                    className="mt-2 w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
                  >
                    {MEMBER_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                  </select>
                  <select
                    value={memberPermissionToAdd}
                    onChange={(event) => setMemberPermissionToAdd(event.target.value)}
                    className="mt-2 w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
                  >
                    {PERMISSION_PROFILES.map((profile) => (
                      <option key={profile} value={profile}>{getPermissionProfileLabel(profile)}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => void handleAddMember()}
                    disabled={!memberToAdd}
                    className="mt-3 rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:text-slate-400"
                  >
                    添加成员
                  </button>
                </div>
              </section>
            </div>
          )}
        </aside>
      ) : null}
    </div>
  );
}
