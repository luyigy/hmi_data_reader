'use client';

import { getSocketClient, type ChatMessage } from '@/lib/websocket-client';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from '@/lib/acpx/permissions';
import type { AcpxPermissionConfig } from '@/lib/acpx/types';
import { buildPermissionConfigFromProfile, taskRoomUser, type TaskInfo, type TaskRunParticipant } from './task-chat-types';
import type { TaskChatState } from './use-task-chat-state';
import type { TaskChatDerived } from './use-task-chat-derived';

export const useTaskChatActions = (state: TaskChatState, derived: TaskChatDerived) => {
  const { task, taskRoom, messageInput, setMessageInput, setIsSending, shouldAutoScrollRef,
    setRoomMessages, fetchRoomMessages, taskId, setControlError, messageTargetType,
    messageTargetParticipantKey, setComposerNotice, fetchRuns, setSelectedRunId,
    fetchSelectedRun, fetchTaskInfo, setTask, setParticipantProbeState,
    setIsExecuting, permissionConfig, setPermissionConfig, setIsSavingPermissionConfig,
    setPermissionConfigNotice, conversationMode, timelineContainerRef,
  } = state;
  const { canContinueSelectedSession, selectedTargetLabel, activeParticipantLabel,
    continuationParticipantLabel, controlRunId, activeRunSummary } = derived;
  const handlePermissionProfileChange = (
    profile: AcpxPermissionConfig['profile']
  ) => {
    setPermissionConfigNotice(null);
    if (profile === 'safe_local' || profile === 'dev_local' || profile === 'full_access') {
      setPermissionConfig(buildPermissionConfigFromProfile(profile, permissionConfig.writableRoots));
      return;
    }

    setPermissionConfig((prev) => ({
      ...prev,
      profile: 'custom',
    }));
  };

  const handlePermissionConfigSave = async (nextConfig?: AcpxPermissionConfig) => {
    const configToSave = nextConfig || permissionConfig;
    setIsSavingPermissionConfig(true);
    setPermissionConfigNotice(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          acpxPermissionConfig: configToSave,
        }),
      });

      if (!res.ok) {
        const error = await res.json().catch(() => null);
        throw new Error(error?.error || '保存权限设置失败');
      }

      const updatedTask: TaskInfo = await res.json();
      setTask(updatedTask);
      setPermissionConfig(updatedTask.acpxPermissionConfig || DEFAULT_ACPX_PERMISSION_CONFIG);
      setPermissionConfigNotice('权限设置已保存；新的 run / continuation 会使用这组配置。');
      return true;
    } catch (error) {
      setPermissionConfigNotice(error instanceof Error ? error.message : '保存权限设置失败');
      return false;
    } finally {
      setIsSavingPermissionConfig(false);
    }
  };

  const handleGrantAgentRights = async (profile: 'dev_local' | 'full_access') => {
    const nextConfig = buildPermissionConfigFromProfile(profile, permissionConfig.writableRoots);
    const defaultContinuationMessage =
      profile === 'full_access'
        ? '我已授予你更高权限。请继续刚才的任务；你现在可以直接修改工作区、联网，并在必要时访问更多本地能力。'
        : '我已授予你开发权限。请继续刚才的任务；你现在可以写工作区并联网，优先直接验证和修复问题。';

    setPermissionConfig(nextConfig);
    const saved = await handlePermissionConfigSave(nextConfig);
    if (!saved) {
      return;
    }

    if (canContinueSelectedSession) {
      await handleAcpxControl(
        'continue_session',
        'immediate',
        messageInput.trim() || defaultContinuationMessage
      );
      return;
    }

    await handleExecuteTask(messageInput.trim() || defaultContinuationMessage);
  };

  const handleSendMessage = async () => {
    if (task?.executionMode === 'acpx') {
      await handleAcpxControl('queue_message', 'queued');
      return;
    }

    const content = messageInput.trim();
    if (!content || !taskRoom) {
      return;
    }

    setIsSending(true);
    shouldAutoScrollRef.current = true;
    try {
      const socket = getSocketClient();
      const optimisticMessage: ChatMessage = {
        id: `temp-${Date.now()}`,
        roomId: taskRoom.id,
        user: taskRoomUser,
        content,
        target: {
          type: 'task',
        },
        createdAt: new Date().toISOString(),
      };

      setRoomMessages((prev) => [...prev, optimisticMessage]);
      setMessageInput('');

      if (socket) {
        socket.emit('chat:message', {
          roomId: taskRoom.id,
          user: taskRoomUser,
          content,
          target: {
            type: 'task',
          },
          createdAt: optimisticMessage.createdAt,
        });
      }

      await fetchRoomMessages(taskRoom.id);
    } catch (error) {
      console.error('Failed to send task room message:', error);
    } finally {
      setIsSending(false);
    }
  };

  const handleAcpxControl = async (
    action: 'queue_message' | 'interrupt_now' | 'stop_run' | 'continue_session',
    deliveryMode: 'queued' | 'immediate',
    overrideContent?: string
  ) => {
    if (!taskRoom || !task) {
      return;
    }

    const rawContent =
      overrideContent
      ?? (
        action === 'interrupt_now'
        ? messageInput.trim() || '请停止当前 turn，并在下一轮等待我的下一条指令。'
        : messageInput
      );
    const content = rawContent.trim();
    if ((action === 'queue_message' || action === 'continue_session') && !content) {
      return;
    }

    setIsSending(true);
    setControlError(null);
    shouldAutoScrollRef.current = true;
    try {
      const taskWasRunning = task.status === 'running';
      const res = await fetch(`/api/tasks/${taskId}/control`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action,
          deliveryMode,
          content,
          runId: controlRunId,
          targetType: messageTargetType,
          targetParticipantKey:
            messageTargetType === 'participant' ? messageTargetParticipantKey : null,
        }),
      });

      if (!res.ok) {
        const error = await res.json().catch(() => null);
        throw new Error(error?.error || '发送控制请求失败');
      }

      const responseData = await res.json().catch(() => null);
      const deliveryResult =
        responseData?.delivery && typeof responseData.delivery.result === 'string'
          ? responseData.delivery.result
          : null;
      const fallbackReason =
        responseData?.delivery && typeof responseData.delivery.fallbackReason === 'string'
          ? responseData.delivery.fallbackReason
          : null;

      if (action === 'queue_message') {
        setComposerNotice(
          taskWasRunning
            ? `消息已记入 task room，并标记给${selectedTargetLabel}；当前 ${
                activeParticipantLabel || 'harness'
              } 忙碌中；后续 handoff 或下一轮运行才会读取。`
            : `消息已记入 task room，并标记给${selectedTargetLabel}；当前没有活动 run，它会先留在 room 中，等你明确点击“开始新 Run”后再作为上下文带入。`
        );
      } else if (action === 'continue_session') {
        setComposerNotice(
          deliveryResult === 'delivered_to_active_thread'
            ? `消息已写入并用于继续${selectedTargetLabel}；平台正在继续 ${
                continuationParticipantLabel || '当前会话'
              } 的同一会话。`
            : `消息已写入 task room，并标记给${selectedTargetLabel}；当前 continuation 未成功送达${fallbackReason ? `（${fallbackReason}）` : ''}。`
        );
      } else if (action === 'interrupt_now') {
        setComposerNotice(
          deliveryResult === 'delivered_control_signal'
            ? '已请求打断当前本地运行；平台会在后续重启时把这条消息带入下一轮。'
            : '中断请求已记录，但当前没有可直接接管的本地进程；后续需要手动重跑或等待下一阶段处理。'
        );
      } else {
        setComposerNotice(
          deliveryResult === 'delivered_control_signal'
            ? '已请求停止当前运行。'
            : '停止请求已记录，但当前没有可直接接管的本地进程。'
        );
      }

      if (!overrideContent) {
        setMessageInput('');
      }
      await fetchRoomMessages(taskRoom.id);
      await fetchRuns();
      const nextRunId =
        typeof responseData?.continuationRunId === 'string' && responseData.continuationRunId
          ? responseData.continuationRunId
          : controlRunId;
      if (nextRunId) {
        setSelectedRunId(nextRunId);
        await fetchSelectedRun(nextRunId);
      }
      await fetchTaskInfo();
    } catch (error) {
      console.error('Failed to send ACPX control message:', error);
      setControlError(error instanceof Error ? error.message : '发送控制请求失败');
    } finally {
      setIsSending(false);
    }
  };

  const waitForTaskToLeaveRunningState = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const res = await fetch(`/api/tasks/${taskId}`);
      const data = await res.json();
      if (data.status !== 'running') {
        setTask(data);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return false;
  };

  const handleHarnessDecision = async (decision: 'allow' | 'deny' | 'explain') => {
    const content =
      decision === 'allow'
        ? '我同意你继续刚才请求的权限或操作。请在下一轮开始时继续，并先简短说明你将执行什么。'
        : decision === 'deny'
        ? '我不同意刚才请求的权限或操作。请在下一轮改用不需要该权限的方案，并说明替代路径。'
        : '请在下一轮先明确说明你刚才需要我确认的具体权限、原因、影响范围，以及你希望我确认什么。';

    await handleAcpxControl('interrupt_now', 'immediate', content);

    if (decision !== 'explain') {
      const readyToRestart = await waitForTaskToLeaveRunningState();
      if (readyToRestart) {
        await handleExecuteTask();
      }
    }
  };

  const handlePrimaryAcpxSend = async () => {
    if (conversationMode === 'run') {
      await handleExecuteTask(messageInput.trim() || undefined);
      return;
    }

    if (!activeRunSummary && canContinueSelectedSession) {
      await handleAcpxControl('continue_session', 'immediate');
      return;
    }

    if (!activeRunSummary) {
      await handleExecuteTask(messageInput.trim() || undefined);
      return;
    }

    await handleAcpxControl('queue_message', 'queued');
  };

  const handleTimelineScroll = () => {
    const container = timelineContainerRef.current;
    if (!container) {
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < 80;
  };

  const handleParticipantConnectivityProbe = async (participant: TaskRunParticipant) => {
    if (participant.executionBackend !== 'gateway_openclaw' || !participant.gatewayId) {
      return;
    }

    setParticipantProbeState((prev) => ({
      ...prev,
      [participant.id]: {
        status: 'testing',
        message: '正在测试远端连接…',
      },
    }));

    try {
      const response = await fetch(`/api/gateways/${participant.gatewayId}/openclaw/respond`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: 'Reply with exactly: ACPX connectivity OK',
          agentId: participant.agentId || undefined,
          sessionKey: `task-${taskId}-probe`,
        }),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || '远端 OpenClaw 连通性测试失败');
      }

      setParticipantProbeState((prev) => ({
        ...prev,
        [participant.id]: {
          status: 'success',
          message: typeof data?.text === 'string' && data.text.trim()
            ? data.text.trim()
            : '远端已返回响应。',
        },
      }));
    } catch (error) {
      setParticipantProbeState((prev) => ({
        ...prev,
        [participant.id]: {
          status: 'error',
          message: error instanceof Error ? error.message : '远端连接测试失败',
        },
      }));
    }
  };

  const handleExecuteTask = async (launchMessage?: string) => {
    setIsExecuting(true);
    try {
      setTask((prev) => (prev ? { ...prev, status: 'running' } : prev));
      shouldAutoScrollRef.current = true;
      const res = await fetch(`/api/tasks/${taskId}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          task?.executionMode === 'acpx'
            ? {
                acpxPermissionConfig: permissionConfig,
                persistAcpxPermissionConfig: true,
                launchMessage: launchMessage || undefined,
                launchTargetType: messageTargetType,
                launchTargetParticipantKey:
                  messageTargetType === 'participant' ? messageTargetParticipantKey : null,
              }
            : {}
        ),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => null);
        throw new Error(error?.error || '执行任务失败');
      }
      const data = await res.json().catch(() => null);
      const nextRunId =
        data && typeof data.taskRunId === 'string' && data.taskRunId
          ? data.taskRunId
          : null;
      await fetchTaskInfo();
      await fetchRuns(nextRunId);
      if (nextRunId) {
        setSelectedRunId(nextRunId);
        await fetchSelectedRun(nextRunId);
      }
      if (launchMessage) {
        setMessageInput('');
      }
    } catch (error) {
      console.error('Failed to execute task:', error);
      await fetchTaskInfo();
    } finally {
      setIsExecuting(false);
    }
  };


  return { handlePermissionProfileChange, handlePermissionConfigSave, handleGrantAgentRights,
    handleSendMessage, handleAcpxControl, handleHarnessDecision, handlePrimaryAcpxSend,
    handleTimelineScroll, handleParticipantConnectivityProbe, handleExecuteTask };
};

export type TaskChatActions = ReturnType<typeof useTaskChatActions>;
