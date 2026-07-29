import { useMemo } from 'react';
import {
  formatPendingAge,
  getMentionQuery,
  getPendingReplyStatusLabel,
  type MentionCandidate,
} from './live-room-workspace-models';
import type { LiveRoomState } from './use-live-room-state';

export function useLiveRoomDerived(state: LiveRoomState) {
  const {
    selectedRoom,
    messageInput,
    rooms,
    availableAgents,
    isRoomsPanelOpen,
    isDetailsPanelOpen,
  } = state;
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

  return {
    activeReplyMembers,
    selectedSpeaker,
    mentionQuery,
    activeRooms,
    archivedRooms,
    pendingSummaryText,
    mentionCandidates,
    addableAgents,
    layoutClass,
  };
}
