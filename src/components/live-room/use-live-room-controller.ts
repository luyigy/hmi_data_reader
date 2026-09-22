'use client';

import type { KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { LiveRoomMessage } from '@/types';
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  getPendingReplyStatusLabel,
  hasMentionAll,
  type MentionCandidate,
  type PendingReply,
  type WorkspacesResponse,
} from './live-room-workspace-models';
import { useLiveRoomEffects } from './use-live-room-effects';
import { useLiveRoomDerived } from './use-live-room-derived';
import { useLiveRoomState } from './use-live-room-state';

export function useLiveRoomController({
  initialRoomId,
  basePath = '/workspaces',
}: {
  initialRoomId?: string;
  basePath?: string;
}) {
  const router = useRouter();
  const state = useLiveRoomState();
  const {
    setRooms,
    setAvailableAgents,
    selectedRoom,
    setSelectedRoom,
    setMessages,
    messageInput,
    setMessageInput,
    draftMentionAll,
    setDraftMentionAll,
    draftMentionMemberIds,
    setDraftMentionMemberIds,
    newRoomTitle,
    setNewRoomTitle,
    newRoomTopic,
    setNewRoomTopic,
    newRoomWorkingDirectory,
    setNewRoomWorkingDirectory,
    selectedAgentIds,
    setSelectedAgentIds,
    selectedAgentRoles,
    setSelectedAgentRoles,
    selectedAgentPermissions,
    setSelectedAgentPermissions,
    selectedTargetMemberId,
    setSelectedTargetMemberId,
    topicDraft,
    setTopicDraft,
    roomTitleDraft,
    setRoomTitleDraft,
    roomDescriptionDraft,
    setRoomDescriptionDraft,
    roomModeDraft,
    setRoomModeDraft,
    memberToAdd,
    setMemberToAdd,
    memberRoleToAdd,
    setMemberRoleToAdd,
    memberPermissionToAdd,
    setMemberPermissionToAdd,
    setIsDetailsPanelOpen,
    setIsLoadingRooms,
    setIsLoadingRoom,
    setIsSending,
    setIsCreating,
    setIsSavingRoomSettings,
    setIsArchivingRoom,
    setIsDeletingRoom,
    setInterruptingMemberId,
    setOpenRoomActionsId,
    setNotice,
    setError,
    messageViewportRef,
    shouldStickToBottomRef,
  } = state;

  const {
    activeReplyMembers,
    selectedSpeaker,
    mentionQuery,
    activeRooms,
    archivedRooms,
    pendingSummaryText,
    mentionCandidates,
    addableAgents,
    layoutClass,
  } = useLiveRoomDerived(state);

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

  useLiveRoomEffects({
    state,
    initialRoomId,
    basePath,
    router,
    pendingSummaryText,
    refreshRooms,
    refreshSelectedRoom,
  });

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
      setMemberPermissionToAdd('dev_local');
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

  const handleUpdateCodexSettings = async (
    memberId: string,
    settings: { codexModel?: string; codexReasoningEffort?: string }
  ) => {
    if (!selectedRoom) return;

    const response = await fetch(`/api/live-rooms/${selectedRoom.id}/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || '更新 Codex 模型设置失败');
      return;
    }
    setNotice('Codex 模型设置已更新，将在下一次 run / continuation 生效。');
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

  return {
    ...state,
    initialRoomId,
    basePath,
    activeReplyMembers, selectedSpeaker, mentionQuery, activeRooms, archivedRooms,
    pendingSummaryText, mentionCandidates, refreshRooms, refreshSelectedRoom,
    handleMessageViewportScroll, handleCreateRoom, handleSendMessage,
    handleInterruptPendingReply, handleUpdateTopic, handleSaveRoomSettings,
    handleOpenRoomSettingsFromList, handleArchiveRoomById, handleArchiveRoom,
    handleHardDeleteRoom, handleHardDeleteRoomById, handleAddMember,
    handleUpdateMemberRole, handleUpdateMemberPermission, handleUpdateCodexSettings,
    handleSetSpeaker, addableAgents, layoutClass, handlePickMention,
    handleComposerChange, handleComposerKeyDown,
  };
}

export type LiveRoomController = ReturnType<typeof useLiveRoomController>;
