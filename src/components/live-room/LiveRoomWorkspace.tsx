'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { getSocketClient } from '@/lib/websocket-client';
import type {
  LiveRoomCatalogAgent,
  LiveRoomDetail,
  LiveRoomMessage,
  LiveRoomSummary,
} from '@/types';

interface LiveRoomsResponse {
  rooms: LiveRoomSummary[];
  availableAgents: LiveRoomCatalogAgent[];
}

type MentionCandidate =
  | { kind: 'all'; id: '__all__'; label: '@all'; subtitle: string }
  | { kind: 'member'; member: LiveRoomDetail['members'][number] };

const ROOMS_PANEL_KEY = 'live-room-left-panel-open';
const DETAILS_PANEL_KEY = 'live-room-right-panel-open';

const getAgentLabel = (agent: LiveRoomCatalogAgent) =>
  `${agent.agentName || agent.label} · ${agent.gatewayName} / ${agent.harnessType}`;

const getMemberLabel = (member: LiveRoomDetail['members'][number]) =>
  member.memberType === 'user'
    ? member.displayName
    : `${member.displayName} · ${member.gatewayName || 'Platform Local'} / ${member.harnessType || 'agent'}`;

const getMemberSubtitle = (member: LiveRoomDetail['members'][number]) =>
  member.memberType === 'user'
    ? '你'
    : `${member.gatewayName || 'Platform Local'} / ${member.harnessType || 'agent'}`;

const getMentionQuery = (value: string) => value.match(/@([\w\u4e00-\u9fa5-]*)$/)?.[1] ?? '';
const hasMentionAll = (value: string) => /(^|[\s(])@all\b/i.test(value);

const getMessageMetadataValue = (message: LiveRoomMessage, key: string) =>
  (message.metadata && typeof message.metadata[key] !== 'undefined') ? message.metadata[key] : null;

const getComposerModeLabel = ({
  draftMentionAll,
  draftMentionMemberIds,
  selectedTargetMemberId,
}: {
  draftMentionAll: boolean;
  draftMentionMemberIds: string[];
  selectedTargetMemberId: string;
}) => {
  if (draftMentionAll) return '@all';
  if (draftMentionMemberIds.length > 0) return 'mention';
  if (selectedTargetMemberId) return 'direct';
  return 'broadcast';
};

export function LiveRoomWorkspace({
  initialRoomId,
}: {
  initialRoomId?: string;
}) {
  const router = useRouter();
  const [rooms, setRooms] = useState<LiveRoomSummary[]>([]);
  const [availableAgents, setAvailableAgents] = useState<LiveRoomCatalogAgent[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<LiveRoomDetail | null>(null);
  const [messages, setMessages] = useState<LiveRoomMessage[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [draftMentionAll, setDraftMentionAll] = useState(false);
  const [draftMentionMemberIds, setDraftMentionMemberIds] = useState<string[]>([]);
  const [newRoomTitle, setNewRoomTitle] = useState('');
  const [newRoomTopic, setNewRoomTopic] = useState('');
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [selectedTargetMemberId, setSelectedTargetMemberId] = useState('');
  const [topicDraft, setTopicDraft] = useState('');
  const [memberToAdd, setMemberToAdd] = useState('');
  const [isRoomsPanelOpen, setIsRoomsPanelOpen] = useState(true);
  const [isDetailsPanelOpen, setIsDetailsPanelOpen] = useState(true);
  const [isLoadingRooms, setIsLoadingRooms] = useState(true);
  const [isLoadingRoom, setIsLoadingRoom] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messageViewportRef = useRef<HTMLDivElement>(null);

  const activeReplyMembers = useMemo(
    () => selectedRoom?.members.filter((member) => member.canReply) || [],
    [selectedRoom?.members]
  );

  const selectedSpeaker = useMemo(
    () => selectedRoom?.members.find((member) => member.id === selectedRoom.currentSpeakerMemberId) || null,
    [selectedRoom?.currentSpeakerMemberId, selectedRoom?.members]
  );

  const mentionQuery = useMemo(() => getMentionQuery(messageInput), [messageInput]);

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

    const allCandidate: MentionCandidate[] = !query || '@all'.includes(`@${query}`) || 'all'.includes(query)
      ? [{
          kind: 'all',
          id: '__all__',
          label: '@all',
          subtitle: `通知当前房间内全部 ${activeReplyMembers.length} 个可回复成员`,
        }]
      : [];

    return [...allCandidate, ...memberCandidates].slice(0, query ? 8 : 20);
  }, [activeReplyMembers.length, mentionQuery, messageInput, selectedRoom]);

  const refreshRooms = async () => {
    setIsLoadingRooms(true);
    try {
      const response = await fetch('/api/live-rooms');
      const data: LiveRoomsResponse = await response.json();
      setRooms(Array.isArray(data.rooms) ? data.rooms : []);
      setAvailableAgents(Array.isArray(data.availableAgents) ? data.availableAgents : []);
    } catch (fetchError) {
      console.error('Failed to fetch live rooms:', fetchError);
      setError('加载 live rooms 失败');
    } finally {
      setIsLoadingRooms(false);
    }
  };

  const refreshSelectedRoom = async (roomId: string) => {
    setIsLoadingRoom(true);
    try {
      const [roomResponse, messagesResponse] = await Promise.all([
        fetch(`/api/live-rooms/${roomId}`),
        fetch(`/api/live-rooms/${roomId}/messages?limit=120`),
      ]);
      const roomData = await roomResponse.json();
      const messagesData = await messagesResponse.json();

      if (!roomResponse.ok) {
        throw new Error(roomData.error || '加载房间详情失败');
      }

      setSelectedRoom(roomData.room || null);
      setMessages(Array.isArray(messagesData.messages) ? messagesData.messages : []);
      setTopicDraft(roomData.room?.currentTopic || '');
      setSelectedTargetMemberId('');
      setDraftMentionAll(false);
      setDraftMentionMemberIds([]);
    } catch (fetchError) {
      console.error('Failed to fetch live room detail:', fetchError);
      setError(fetchError instanceof Error ? fetchError.message : '加载房间详情失败');
    } finally {
      setIsLoadingRoom(false);
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
      void refreshSelectedRoom(initialRoomId);
      return;
    }

    setSelectedRoom(null);
    setMessages([]);
  }, [initialRoomId]);

  useEffect(() => {
    const socket = getSocketClient();
    if (!socket || !initialRoomId) {
      return;
    }

    const handleMessage = (message: LiveRoomMessage) => {
      if (message.roomId !== initialRoomId) {
        return;
      }

      setMessages((prev) => prev.some((item) => item.id === message.id) ? prev : [...prev, message]);
    };

    const handleRoomUpdated = (summary: LiveRoomSummary) => {
      setRooms((prev) => {
        const next = prev.some((room) => room.id === summary.id)
          ? prev.map((room) => room.id === summary.id ? summary : room)
          : [summary, ...prev];
        return [...next].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
      });

      if (summary.id === initialRoomId) {
        void refreshSelectedRoom(initialRoomId);
      }
    };

    if (!socket.connected) {
      socket.connect();
    }

    socket.emit('live-room:join', { roomId: initialRoomId });
    socket.on('live-room:message', handleMessage);
    socket.on('live-room:updated', handleRoomUpdated);

    return () => {
      socket.off('live-room:message', handleMessage);
      socket.off('live-room:updated', handleRoomUpdated);
    };
  }, [initialRoomId]);

  useEffect(() => {
    const viewport = messageViewportRef.current;
    if (!viewport) {
      return;
    }

    viewport.scrollTop = viewport.scrollHeight;
  }, [messages]);

  const handleCreateRoom = async () => {
    if (!newRoomTitle.trim()) {
      setError('请先输入 room title');
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
          selectedAgentIds,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '创建房间失败');
      }

      setNewRoomTitle('');
      setNewRoomTopic('');
      setSelectedAgentIds([]);
      setNotice('新 live room 已创建。');
      await refreshRooms();
      if (data.room?.id) {
        router.push(`/rooms/${data.room.id}`);
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

    setIsSending(true);
    setError(null);
    try {
      const hasStructuredMention = draftMentionAll || draftMentionMemberIds.length > 0;
      const response = await fetch(`/api/live-rooms/${selectedRoom.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: messageInput.trim(),
          targetMemberId: hasStructuredMention ? undefined : (selectedTargetMemberId || undefined),
          explicitMentionAll: draftMentionAll,
          explicitMentionMemberIds: draftMentionMemberIds,
          autoReply: true,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '发送消息失败');
      }

      setMessageInput('');
      setDraftMentionAll(false);
      setDraftMentionMemberIds([]);
      setNotice(draftMentionAll && selectedRoom
        ? `消息已发送，@all 会通知当前房间内全部 ${selectedRoom.members.filter((member) => member.canReply && member.memberType !== 'user').length} 个可回复成员，并按顺序回复。`
        : hasStructuredMention && selectedRoom
        ? `消息已发送，这条消息会优先按 mention 路由给 ${draftMentionMemberIds.map((memberId) => selectedRoom.members.find((member) => member.id === memberId)?.displayName).filter(Boolean).join('、')}。`
        : selectedTargetMemberId
        ? '消息已发送，这条消息会优先由你在 dropdown 里选中的 agent 回复。'
        : '消息已发送，这是一条面向整个房间的公开消息，当前 speaker 会优先接话。');
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
      await refreshSelectedRoom(selectedRoom.id);
      await refreshRooms();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : '发送消息失败');
    } finally {
      setIsSending(false);
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
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '添加成员失败');
      }
      setMemberToAdd('');
      setNotice(data.duplicate ? '该 agent 已在房间里。' : '成员已加入房间。');
      await refreshSelectedRoom(selectedRoom.id);
      await refreshRooms();
    } catch (memberError) {
      setError(memberError instanceof Error ? memberError.message : '添加成员失败');
    }
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
      setMessageInput((prev) => prev.replace(/@([\w\u4e00-\u9fa5-]*)$/, '@all '));
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
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Live Rooms</div>
                <div className="mt-2 text-lg font-semibold text-slate-900">多 Agent 实时协作</div>
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
            <div className="text-sm font-medium text-slate-900">新建房间</div>
            <input
              value={newRoomTitle}
              onChange={(event) => setNewRoomTitle(event.target.value)}
              placeholder="例如：跨网关 OCR 讨论室"
              className="mt-3 w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none ring-0 transition focus:border-slate-500"
            />
            <textarea
              value={newRoomTopic}
              onChange={(event) => setNewRoomTopic(event.target.value)}
              rows={2}
              placeholder="给这个房间一个当前 topic / task..."
              className="mt-2 w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none ring-0 transition focus:border-slate-500"
            />
            <div className="mt-2 max-h-36 space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-2">
              {availableAgents.map((agent) => {
                const checked = selectedAgentIds.includes(agent.id);
                return (
                  <label key={agent.id} className="flex cursor-pointer items-start gap-2 rounded-xl px-2 py-1.5 hover:bg-slate-50">
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
                  </label>
                );
              })}
            </div>
            <button
              onClick={() => void handleCreateRoom()}
              disabled={isCreating}
              className="mt-3 w-full rounded-full bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:bg-slate-400"
            >
              {isCreating ? '创建中...' : '创建 Live Room'}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
            {isLoadingRooms ? (
              <div className="px-3 py-4 text-sm text-slate-500">加载房间中...</div>
            ) : rooms.length === 0 ? (
              <div className="px-3 py-4 text-sm text-slate-500">还没有 live room，先创建一个。</div>
            ) : (
              <div className="space-y-1">
                {rooms.map((room) => {
                  const isActive = room.id === selectedRoom?.id || room.id === initialRoomId;
                  return (
                    <Link
                      key={room.id}
                      href={`/rooms/${room.id}`}
                      className={`block rounded-2xl px-3 py-3 transition ${
                        isActive ? 'bg-white shadow-sm ring-1 ring-slate-200' : 'hover:bg-white/70'
                      }`}
                    >
                      <div className="truncate text-sm font-medium text-slate-900">{room.title}</div>
                      <div className="mt-1 truncate text-xs text-slate-500">{room.currentTopic || '暂未设置 topic'}</div>
                      <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-400">
                        <span>{room.memberCount} members</span>
                        <span className="truncate">{room.currentSpeakerName || '无 speaker'}</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </aside>
      ) : null}

      <section className="grid min-h-0 grid-rows-[auto,minmax(0,1fr),auto] bg-[#fcfcfd]">
        {!selectedRoom && !initialRoomId ? (
          <div className="flex h-full items-center justify-center px-10">
            <div className="max-w-2xl text-center">
              <div className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">Live Agent Room</div>
              <h1 className="mt-4 text-4xl font-semibold text-slate-900">像 ChatGPT 一样进入持续协作房间</h1>
              <p className="mt-4 text-base leading-7 text-slate-600">
                先创建房间、邀请来自任意 gateway 的 agent，然后在中间持续讨论 topic。
                这里的主语义是房间和对话，不再被 task run 控制台绑住。
              </p>
              {!isRoomsPanelOpen ? (
                <button
                  onClick={() => setIsRoomsPanelOpen(true)}
                  className="mt-6 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  显示 Live Rooms
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            <header className="border-b border-slate-200 bg-white px-6 py-3">
              <div className="flex items-start justify-between gap-6">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Live Collaboration Room</div>
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
                  {!isRoomsPanelOpen ? (
                    <button
                      onClick={() => setIsRoomsPanelOpen(true)}
                      className="rounded-full border border-slate-300 bg-white px-3 py-1 font-medium text-slate-600 transition hover:bg-slate-50"
                    >
                      显示 Live Rooms
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

            <div ref={messageViewportRef} className="min-h-0 overflow-y-auto px-5 py-3">
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

                    if (isSystem) {
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
                          <div className={`mb-1 text-[10px] ${isUser ? 'text-slate-300' : 'text-slate-500'}`}>
                            {message.senderLabel || message.senderName} · {new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false })}
                          </div>
                          {Array.isArray(getMessageMetadataValue(message, 'mentionedMemberIds')) || getMessageMetadataValue(message, 'primaryTargetMemberId') || getMessageMetadataValue(message, 'mentionedAll') ? (
                            <div className="mb-2 flex flex-wrap gap-1.5">
                              {typeof getMessageMetadataValue(message, 'deliveryIntent') === 'string' ? (
                                <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                                  isUser ? 'bg-white/10 text-slate-200' : 'bg-slate-100 text-slate-600'
                                }`}>
                                  {String(getMessageMetadataValue(message, 'deliveryIntent'))}
                                </span>
                              ) : null}
                              {getMessageMetadataValue(message, 'mentionedAll') ? (
                                <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                                  isUser ? 'bg-white/10 text-slate-200' : 'bg-slate-100 text-slate-600'
                                }`}>
                                  @all
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
                      ? '这条消息带有 @all，当前房间内所有可回复成员都会收到并按顺序回应。'
                      : draftMentionMemberIds.length > 0
                      ? '这条消息包含结构化 mention，本次会优先按 mention 路由。'
                      : selectedTargetMemberId
                      ? '这条消息会优先投递给你在 dropdown 里选中的 agent。'
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
                            {member.kind === 'all' ? '@all' : `@${member.member.displayName}`}
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
                      ? `已结构化 mention：@all（${selectedRoom.members.filter((member) => member.canReply && member.memberType !== 'user').length} 个可回复成员）`
                      : draftMentionMemberIds.length > 0 && selectedRoom
                      ? `已结构化 mention：${draftMentionMemberIds.map((memberId) => selectedRoom.members.find((member) => member.id === memberId)?.displayName).filter(Boolean).join('、')}`
                      : selectedSpeaker
                      ? `当前主回复 agent：${getMemberLabel(selectedSpeaker)}`
                      : '还没有 speaker，先在右侧选择一个可回复成员。'}
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
              {notice ? (
                <div className="mx-auto mt-2 max-w-4xl rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-700">
                  {notice}
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
                <div className="text-sm font-medium text-slate-900">房间成员</div>
                <div className="mt-3 space-y-2">
                  {selectedRoom.members.map((member) => (
                    <div key={member.id} className="rounded-2xl bg-slate-50 px-3 py-2">
                      <div className="truncate text-sm font-medium text-slate-800">{member.displayName}</div>
                      <div className="mt-1 text-[11px] text-slate-500">
                        {getMemberSubtitle(member)}
                      </div>
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
