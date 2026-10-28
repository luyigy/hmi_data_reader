'use client';

import { useEffect, useMemo } from 'react';
import { selectActiveTaskRun } from '@/lib/acpx/run-selection';
import { getTaskRoomParticipantTargetKey, getTaskRoomParticipantTargetLabel } from '@/lib/task-room-targets';
import { getLocalHarnessPermissionSupport, type AcpxPermissionSupportSummary } from '@/lib/acpx/permissions';
import type { AcpxPermissionConfig } from '@/lib/acpx/types';
import { workflowPermissionSnapshotFrom } from '@/components/tasks/WorkflowPermissionSnapshotCard';
import type { ConversationFeedItem, TaskRoomMessageTargetOption } from './task-chat-types';
import type { TaskChatState } from './use-task-chat-state';

export const useTaskChatDerived = (state: TaskChatState) => {
  const { selectedRun, task, messageTargetType, messageTargetParticipantKey, roomMessages,
    setMessageTargetParticipantKey, runSummaries, conversationMode } = state;
  const selectedRunEvents = useMemo(() => selectedRun?.events || [], [selectedRun]);
  const latestHarnessRequest = useMemo(() => {
    if (
      !selectedRun
      || selectedRun.status !== 'waiting_for_input'
    ) {
      return null;
    }

    for (let index = selectedRunEvents.length - 1; index >= 0; index -= 1) {
      const event = selectedRunEvents[index];
      const requestKind =
        event.eventType === 'control_message'
        && event.metadata
        && typeof event.metadata.requestKind === 'string'
          ? event.metadata.requestKind
          : null;
      const requestRunStatus =
        event.eventType === 'control_message'
        && event.metadata
        && typeof event.metadata.runStatus === 'string'
          ? event.metadata.runStatus
          : null;

      if (requestKind && requestRunStatus === 'waiting_for_input') {
        return {
          kind: requestKind,
          message: event.content,
          excerpt:
            event.metadata && typeof event.metadata.excerpt === 'string'
              ? event.metadata.excerpt
              : null,
        };
      }
    }

    return null;
  }, [selectedRun, selectedRunEvents]);

  const latestHarnessRequestIsActionable =
    latestHarnessRequest?.kind === 'permission_request'
    || latestHarnessRequest?.kind === 'input_request'
    || latestHarnessRequest?.kind === 'choice_request';

  const activeParticipant = useMemo(
    () =>
      selectedRun?.participants.find(
        (participant) => participant.status === 'running' || participant.status === 'waiting_for_input'
      ) || null,
    [selectedRun?.participants]
  );

  const activeParticipantLabel = activeParticipant
    ? `${activeParticipant.role} · ${
        activeParticipant.executionBackend === 'platform_local'
          ? 'Platform Local'
          : activeParticipant.gatewayName
      } / ${activeParticipant.harnessType}`
    : null;

  const continuationParticipant = useMemo(() => {
    if (!selectedRun || task?.status === 'running') {
      return null;
    }

    const participants = selectedRun.participants.filter((participant) => {
      const sessionId =
        participant.controlMetadata?.lastSessionId
        ?? participant.controlMetadata?.claudeSessionId
        ?? participant.controlMetadata?.codexThreadId
        ?? participant.controlMetadata?.lastSessionThreadId;
      return (
        typeof sessionId === 'string'
        && sessionId.trim().length > 0
      );
    });

    if (participants.length === 0) {
      return null;
    }

    if (messageTargetType === 'participant') {
      return participants.find(
        (participant) =>
          getTaskRoomParticipantTargetKey({
            executionBackend: participant.executionBackend,
            gatewayId: participant.gatewayId,
            harnessType: participant.harnessType,
            role: participant.role,
            agentId: participant.agentId,
          }) === messageTargetParticipantKey
      ) || null;
    }

    return participants[0] || null;
  }, [messageTargetParticipantKey, messageTargetType, selectedRun, task?.status]);

  const continuationParticipantLabel = continuationParticipant
    ? `${continuationParticipant.role} · ${
        continuationParticipant.executionBackend === 'platform_local'
          ? 'Platform Local'
          : continuationParticipant.gatewayName
      } / ${continuationParticipant.harnessType}`
    : null;

  const canContinueSelectedSession = !!continuationParticipant;

  const conversationFeed = useMemo<ConversationFeedItem[]>(() => {
    const roomItems = roomMessages.map((message) => ({
      id: `room-${message.id}`,
      createdAt: message.createdAt,
      type: 'room_message' as const,
      roomMessage: message,
    }));
    const eventItems = selectedRunEvents.map((event) => ({
      id: `event-${event.id}`,
      createdAt: event.createdAt,
      type: 'run_event' as const,
      runEvent: event,
    }));

    return [...roomItems, ...eventItems].sort(
      (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    );
  }, [roomMessages, selectedRunEvents]);

  const remoteQuietHint = useMemo(() => {
    if (
      !selectedRun
      || selectedRun.status !== 'running'
      || !activeParticipant
      || activeParticipant.executionBackend !== 'gateway_openclaw'
    ) {
      return null;
    }

    const lastEventTime = selectedRunEvents.length > 0
      ? new Date(selectedRunEvents[selectedRunEvents.length - 1].createdAt).getTime()
      : null;
    const quietMinutes = lastEventTime
      ? Math.max(0, Math.floor((Date.now() - lastEventTime) / 60000))
      : null;

    return quietMinutes && quietMinutes >= 1
      ? `当前是远端 ${activeParticipantLabel} 在运行，可能只会在完成后返回结果。已经安静 ${quietMinutes} 分钟，这不一定表示它已卡死。`
      : `当前是远端 ${activeParticipantLabel} 在运行，可能只会在完成后返回结果；没有流式输出不一定表示它已卡死。`;
  }, [activeParticipant, activeParticipantLabel, selectedRun, selectedRunEvents]);

  const selectedRunSessionTracking = useMemo(() => {
    const metadata = selectedRun?.controlMetadata;
    if (!metadata || typeof metadata !== 'object') {
      return null;
    }

    const tracking = metadata.sessionTracking;
    return tracking && typeof tracking === 'object'
      ? tracking as Record<string, unknown>
      : null;
  }, [selectedRun?.controlMetadata]);

  const selectedRunSessionTrackingLabel = useMemo(() => {
    if (!selectedRunSessionTracking) {
      return null;
    }

    const sameSessionConfirmed = selectedRunSessionTracking.sameSessionConfirmed;
    const actualThreadId = typeof selectedRunSessionTracking.actualThreadId === 'string'
      ? selectedRunSessionTracking.actualThreadId
      : null;

    if (sameSessionConfirmed === true) {
      return actualThreadId
        ? `same Codex session confirmed · ${actualThreadId}`
        : 'same Codex session confirmed';
    }

    if (sameSessionConfirmed === false) {
      return 'Codex session mismatch detected';
    }

    return null;
  }, [selectedRunSessionTracking]);

  const selectedRunPermissionConfig = useMemo(() => {
    const metadata = selectedRun?.controlMetadata;
    if (!metadata || typeof metadata !== 'object') {
      return null;
    }

    const config = metadata.permissionConfig;
    return config && typeof config === 'object'
      ? config as AcpxPermissionConfig
      : null;
  }, [selectedRun?.controlMetadata]);
  const selectedRunWorkflowPermissionSnapshot = workflowPermissionSnapshotFrom(selectedRunPermissionConfig);

  const draftPermissionSupport = useMemo<AcpxPermissionSupportSummary | null>(() => {
    const primaryParticipant = task?.acpxParticipants?.[0];
    if (!primaryParticipant) {
      return null;
    }

    return getLocalHarnessPermissionSupport(
      primaryParticipant.harnessType,
      primaryParticipant.executionBackend
    );
  }, [task?.acpxParticipants]);

  const selectedRunPermissionSupport = useMemo<AcpxPermissionSupportSummary | null>(() => {
    const metadata = selectedRun?.controlMetadata;
    if (!metadata || typeof metadata !== 'object') {
      return null;
    }

    const supportEntries = Array.isArray(metadata.permissionSupport)
      ? metadata.permissionSupport
      : [];
    const firstSupport = supportEntries[0];
    if (
      firstSupport
      && typeof firstSupport === 'object'
      && 'support' in firstSupport
      && firstSupport.support
      && typeof firstSupport.support === 'object'
    ) {
      return firstSupport.support as AcpxPermissionSupportSummary;
    }

    return draftPermissionSupport;
  }, [draftPermissionSupport, selectedRun?.controlMetadata]);

  const draftPermissionStatusItems = useMemo(() => {
    if (!draftPermissionSupport) {
      return [];
    }

    return [
      { key: 'sandbox', label: 'Sandbox', state: draftPermissionSupport.sandboxMode },
      { key: 'approval', label: 'Approval', state: draftPermissionSupport.approvalPolicy },
      { key: 'network', label: 'Network', state: draftPermissionSupport.networkAccess },
      { key: 'writable-roots', label: 'Writable Roots', state: draftPermissionSupport.writableRoots },
    ];
  }, [draftPermissionSupport]);

  const selectedRunPermissionStatusItems = useMemo(() => {
    if (!selectedRunPermissionSupport) {
      return [];
    }

    return [
      { key: 'sandbox', label: 'run sandbox', state: selectedRunPermissionSupport.sandboxMode },
      { key: 'approval', label: 'run approval', state: selectedRunPermissionSupport.approvalPolicy },
      { key: 'network', label: 'run network', state: selectedRunPermissionSupport.networkAccess },
      { key: 'writable-roots', label: 'run writable roots', state: selectedRunPermissionSupport.writableRoots },
    ];
  }, [selectedRunPermissionSupport]);

  const taskRoomTargetOptions = useMemo<TaskRoomMessageTargetOption[]>(() => {
    const participantOptions = (task?.acpxParticipants || []).map((participant) => ({
      type: 'participant' as const,
      participantKey: getTaskRoomParticipantTargetKey(participant),
      participantLabel: getTaskRoomParticipantTargetLabel(participant),
      label: getTaskRoomParticipantTargetLabel(participant),
    }));

    return [
      { type: 'task', label: '整个任务' },
      ...participantOptions,
      { type: 'all', label: '全部参与方' },
    ];
  }, [task?.acpxParticipants]);

  const selectedTargetLabel = useMemo(() => {
    if (messageTargetType === 'all') {
      return '全部参与方';
    }

    if (messageTargetType === 'participant') {
      return (
        taskRoomTargetOptions.find(
          (option) => option.type === 'participant' && option.participantKey === messageTargetParticipantKey
        )?.participantLabel || '指定参与方'
      );
    }

    return '整个任务';
  }, [messageTargetParticipantKey, messageTargetType, taskRoomTargetOptions]);

  const selectedTargetParticipantSpec = useMemo(() => {
    if (messageTargetType !== 'participant') {
      return null;
    }

    return (
      (task?.acpxParticipants || []).find(
        (participant) => getTaskRoomParticipantTargetKey(participant) === messageTargetParticipantKey
      ) || null
    );
  }, [messageTargetParticipantKey, messageTargetType, task?.acpxParticipants]);

  const targetDeliveryHint = useMemo(() => {
    if (messageTargetType === 'task') {
      return '会写入 task room，供当前或后续 run 作为共享上下文读取。';
    }

    if (messageTargetType === 'all') {
      return '会写入 task room，作为给全部参与方的共享说明；不是同时实时推送到每个 participant。';
    }

    if (!selectedTargetParticipantSpec) {
      return '会写入 task room，供后续匹配的参与方读取。';
    }

    const targetKind =
      selectedTargetParticipantSpec.executionBackend === 'gateway_openclaw'
        ? '远端 gateway 参与方'
        : '参与方';

    return `会写入 task room，作为留给${targetKind} ${selectedTargetLabel} 的上下文；当前不是实时直达消息。`;
  }, [messageTargetType, selectedTargetLabel, selectedTargetParticipantSpec]);

  useEffect(() => {
    if (messageTargetType !== 'participant') {
      return;
    }

    if (
      taskRoomTargetOptions.some(
        (option) => option.type === 'participant' && option.participantKey === messageTargetParticipantKey
      )
    ) {
      return;
    }

    const firstParticipantOption = taskRoomTargetOptions.find((option) => option.type === 'participant');
    setMessageTargetParticipantKey(firstParticipantOption?.participantKey || '');
  }, [messageTargetParticipantKey, messageTargetType, taskRoomTargetOptions]);


  const { hasActiveRuns, controlRun: activeRunSummary } = selectActiveTaskRun(runSummaries, selectedRun?.id);
  const canExecute = !!task && task.status !== 'running' && !hasActiveRuns;
  const controlRunId = activeRunSummary?.id ?? null;
  const controlRunCanInterrupt =
    activeRunSummary?.status === 'running' || activeRunSummary?.status === 'waiting_for_input'
      ? activeRunSummary.participants.some((participant) => participant.interruptSupported)
      : false;
  const controlRunCanStop =
    activeRunSummary?.status === 'running' || activeRunSummary?.status === 'waiting_for_input'
      ? activeRunSummary.participants.some((participant) => participant.softStopSupported || participant.interruptSupported)
      : false;
  const controlRunLabel = activeRunSummary
    ? `当前控制目标：Run ${runSummaries.findIndex((run) => run.id === activeRunSummary.id) >= 0 ? runSummaries.length - runSummaries.findIndex((run) => run.id === activeRunSummary.id) : 'active'}（${activeRunSummary.status}）`
    : hasActiveRuns ? '有多个活动 Run，请先选择要控制的 Run' : '当前还没有可控制的 Run';
  const selectedRunLabel = selectedRun
    ? `当前查看：Run ${runSummaries.findIndex((run) => run.id === selectedRun.id) >= 0 ? runSummaries.length - runSummaries.findIndex((run) => run.id === selectedRun.id) : 'selected'}（${selectedRun.status}）`
    : '当前查看：Task Room';
  const selectedRunIsActive = !!selectedRun && ['pending', 'running', 'waiting_for_input'].includes(selectedRun.status);
  const primarySendLabel = task?.executionMode === 'acpx'
    ? conversationMode === 'chat'
      ? '发送到对话'
      : '基于当前对话启动 Run'
    : '发送到 Task Room';
  const composerBehaviorHint = task?.executionMode === 'acpx'
    ? conversationMode === 'chat'
      ? hasActiveRuns
        ? `聊天模式下，消息会先写入 task room。当前 active run 仍在执行时，它不会被原地接管；participant target 也只是供后续读取。`
        : canContinueSelectedSession
        ? `聊天模式下会优先继续 ${continuationParticipantLabel || '当前会话'}；如果没有可续接会话，就会直接拉起一个新的 agent run 来回复。`
        : '聊天模式下如果没有 active run，主按钮会直接拉起新的 agent run 来回复，而不是只把消息留在 task room。'
      : hasActiveRuns
      ? `执行模式下只会控制 active run。当前已有 active run，不能再启动新 run；如需介入，请使用打断或停止。`
      : '执行模式下会把当前输入先写入 task room，再基于最近对话上下文启动新的 run。'
    : null;
  return {
    selectedRunEvents, latestHarnessRequest, latestHarnessRequestIsActionable,
    activeParticipant, activeParticipantLabel, continuationParticipant,
    continuationParticipantLabel, canContinueSelectedSession, conversationFeed,
    remoteQuietHint, selectedRunSessionTracking, selectedRunSessionTrackingLabel,
    selectedRunPermissionConfig, selectedRunWorkflowPermissionSnapshot,
    draftPermissionSupport, selectedRunPermissionSupport, draftPermissionStatusItems,
    selectedRunPermissionStatusItems, taskRoomTargetOptions, selectedTargetLabel,
    selectedTargetParticipantSpec, targetDeliveryHint, activeRunSummary, hasActiveRuns, canExecute,
    controlRunId, controlRunCanInterrupt, controlRunCanStop, controlRunLabel,
    selectedRunLabel, selectedRunIsActive, primarySendLabel, composerBehaviorHint,
  };
};

export type TaskChatDerived = ReturnType<typeof useTaskChatDerived>;
