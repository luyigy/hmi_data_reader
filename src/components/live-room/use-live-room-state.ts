import { useRef, useState } from 'react';
import type { LiveRoomCatalogAgent, LiveRoomMessage, WorkspaceDetail, WorkspaceSummary } from '@/types';

export function useLiveRoomState() {
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
  const [memberPermissionToAdd, setMemberPermissionToAdd] = useState('dev_local');
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

  return {
    rooms,
    setRooms,
    availableAgents,
    setAvailableAgents,
    selectedRoom,
    setSelectedRoom,
    messages,
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
    isRoomsPanelOpen,
    setIsRoomsPanelOpen,
    isDetailsPanelOpen,
    setIsDetailsPanelOpen,
    isLoadingRooms,
    setIsLoadingRooms,
    isLoadingRoom,
    setIsLoadingRoom,
    isSending,
    setIsSending,
    isCreating,
    setIsCreating,
    isSavingRoomSettings,
    setIsSavingRoomSettings,
    isArchivingRoom,
    setIsArchivingRoom,
    isDeletingRoom,
    setIsDeletingRoom,
    interruptingMemberId,
    setInterruptingMemberId,
    openRoomActionsId,
    setOpenRoomActionsId,
    showArchivedRooms,
    setShowArchivedRooms,
    isSocketConnected,
    setIsSocketConnected,
    notice,
    setNotice,
    error,
    setError,
    dismissedNotice,
    setDismissedNotice,
    dismissedPendingSummary,
    setDismissedPendingSummary,
    messageViewportRef,
    shouldStickToBottomRef,
  };
}

export type LiveRoomState = ReturnType<typeof useLiveRoomState>;
