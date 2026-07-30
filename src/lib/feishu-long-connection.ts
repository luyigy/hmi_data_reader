import * as Lark from '@larksuiteoapi/node-sdk';
import { prisma } from '@/lib/prisma';
import {
  hydrateFeishuMessageResources,
  handleFeishuCommand,
  parseFeishuCommand,
  parseFeishuMessageContent,
} from '@/lib/feishu';
import { addTypingReaction, removeTypingReaction, sendFeishuTextMessage, updateFeishuApprovalCardResolved } from '@/lib/feishu-api';
import { resolveInteractionRequestWithContinuation } from '@/lib/acpx/interaction-actions';
import { tryRelayNonCommandToLiveRoom, UNBOUND_FEISHU_LIVE_ROOM_HINT } from '@/lib/feishu-live-room';
import {
  createFeishuRuntimeStatus,
  readFeishuRuntimeStatus,
  updateFeishuRuntimeStatus,
} from '@/lib/feishu-runtime-status';
import { maybeSendFeishuSessionWatermarkWarning } from '@/lib/feishu-session-continuity';
import { checkFeishuDirectMessageAccess, isFeishuAdmin, resolveFeishuAdminApproval } from '@/lib/feishu-access-approval';
import {
  resolveWorkflowReviewCardAction,
  resolveWorkflowRevisionFeedback,
  resolveWorkflowRevisionFeedbackCardAction,
  type WorkflowReviewDecision,
} from '@/lib/scheduled-jobs/workflow-review';
import { handleWorkflowDashboardCardAction } from '@/lib/feishu-scheduled-jobs';
import {
  resolveFeishuCardActionIdentity,
  type FeishuCardActionIdentity,
} from '@/lib/feishu-card-action';
import { claimFeishuMessage } from '@/lib/feishu-message-dedup';
import { FEISHU_COMMAND_CARD_ACTIONS } from '@/lib/feishu-help';
export { resolveFeishuCardActionIdentity } from '@/lib/feishu-card-action';

type FeishuLongConnectionState = {
  status: 'idle' | 'disabled' | 'starting' | 'running' | 'error';
  startedAt?: string;
  lastError?: string;
  startPromise?: Promise<void>;
  messageIds: Map<string, number>;
};

type FeishuWsMessagePayload = {
  sender?: {
    sender_id?: {
      open_id?: string;
    };
  };
  message?: {
    chat_id?: string;
    chat_type?: string;
    message_id?: string;
    parent_id?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{
      id?: {
        open_id?: string;
      };
      name?: string;
    }>;
  };
};

const globalForFeishuLongConnection = globalThis as unknown as {
  feishuLongConnection?: FeishuLongConnectionState;
};

function getState(): FeishuLongConnectionState {
  if (!globalForFeishuLongConnection.feishuLongConnection) {
    globalForFeishuLongConnection.feishuLongConnection = {
      status: 'idle',
      messageIds: new Map(),
    };
  }

  return globalForFeishuLongConnection.feishuLongConnection;
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function resolveBaseUrl(): string {
  return process.env.AGENT_PLATFORM_BASE_URL?.trim() || 'http://127.0.0.1:3010';
}

function shouldUseLongConnection() {
  const mode = process.env.FEISHU_CONNECTION_MODE?.trim() || 'long_connection';
  return mode === 'long_connection';
}

export function buildFeishuRuntimeRecoveryCommand(content: string) {
  const plan = content.match(/docs\/\d+_PLAN_[^\s`]+\.md/)?.[0];
  const handover = Array.from(content.matchAll(/docs\/\d+_HANDOVER_[^\s`]+\.md/g)).at(-1)?.[0];
  const slice = content.match(/的 (S\d{2,})/)?.[1];
  return plan && handover && slice
    ? `/ap chat 重新执行 ${plan} 的 ${slice}；严格读取 ${handover} 中的 WORKFLOW_PROMPT 并执行，完成后提交并停止。`
    : '/ap chat 继续执行刚才因服务中断而停止的任务；先检查并保护现有未提交改动，完成后提交并停止。';
}

async function failAndNotifyInterruptedDeliveries(reason: string) {
  const deliveries = await prisma.liveRoomDelivery.findMany({
    where: { deliveryStatus: 'running' },
    select: {
      id: true,
      targetMember: {
        select: { displayName: true, userNickname: true },
      },
      roomMessage: {
        select: {
          content: true,
          room: {
            select: {
              feishuBindings: {
                orderBy: { updatedAt: 'desc' },
                take: 1,
                select: { chatId: true },
              },
            },
          },
        },
      },
    },
  });
  if (!deliveries.length) return 0;
  await prisma.liveRoomDelivery.updateMany({
    where: { id: { in: deliveries.map(({ id }) => id) } },
    data: { deliveryStatus: 'failed', fallbackReason: reason, acknowledgedAt: new Date() },
  });
  await Promise.all(deliveries.map(async (delivery) => {
    const chatId = delivery.roomMessage.room.feishuBindings[0]?.chatId;
    if (!chatId) return;
    const member = delivery.targetMember.userNickname || delivery.targetMember.displayName;
    await sendFeishuTextMessage({
      receiveId: chatId,
      receiveIdType: 'chat_id',
      text: [
        `⚠️ 系统提示：服务中断或重启已停止 ${member} 的当前运行。`,
        `恢复命令：${buildFeishuRuntimeRecoveryCommand(delivery.roomMessage.content)}`,
        '请等待服务恢复后再发送；系统不会自动复用已结束的旧进程。',
      ].join('\n'),
    }).catch((error) => console.warn('[FeishuRuntime] failed to send recovery notice:', error));
  }));
  return deliveries.length;
}

function pruneSeenMessageIds(state: FeishuLongConnectionState) {
  const now = Date.now();
  for (const [messageId, timestamp] of Array.from(state.messageIds.entries())) {
    if (now - timestamp > 10 * 60 * 1000) {
      state.messageIds.delete(messageId);
    }
  }

  if (state.messageIds.size > 1000) {
    const oldestKeys = Array.from(state.messageIds.entries())
      .sort((a, b) => a[1] - b[1])
      .slice(0, state.messageIds.size - 800)
      .map(([messageId]) => messageId);
    for (const messageId of oldestKeys) {
      state.messageIds.delete(messageId);
    }
  }
}

function parseWsIncomingMessage(payload: FeishuWsMessagePayload) {
  const message = payload.message;
  const senderOpenId = payload.sender?.sender_id?.open_id;
  if (!message?.chat_id || !message.message_id || !message.content || !senderOpenId) {
    return null;
  }

  const parsedContent = parseFeishuMessageContent(message.message_type, message.content);

  if (!parsedContent?.text) {
    return null;
  }

  return {
    chatId: message.chat_id,
    chatType: message.chat_type || 'group',
    messageId: message.message_id,
    parentId: message.parent_id,
    senderOpenId,
    messageType: parsedContent.messageType,
    text: parsedContent.text,
    fileKey: parsedContent.fileKey,
    fileKeys: parsedContent.fileKeys,
    mentions: (message.mentions || [])
      .map((mention) => mention.id?.open_id)
      .filter((value): value is string => !!value),
    mentionNames: (message.mentions || [])
      .map((mention) => mention.name?.trim())
      .filter((value): value is string => !!value),
  };
}

function getFallbackStatus(host: 'standalone' | 'nextjs' = 'standalone') {
  const state = getState();
  return createFeishuRuntimeStatus({
    status: state.status,
    host,
    pid: host === 'standalone' ? process.pid : null,
    startedAt: state.startedAt || null,
    lastError: state.lastError || null,
  });
}

function markRuntimeStatus(
  host: 'standalone' | 'nextjs',
  overrides: Partial<ReturnType<typeof createFeishuRuntimeStatus>>
) {
  return updateFeishuRuntimeStatus({
    mode: process.env.FEISHU_CONNECTION_MODE?.trim() || 'long_connection',
    host,
    pid: process.pid,
    ...overrides,
  });
}

function buildCardActionHandler(prefix: string) {
  return async (data: Lark.InteractiveCardActionEvent) => {
    const cmd = typeof data?.action?.value?.cmd === 'string' ? (data.action.value.cmd as string) : null;
    if (!cmd) {
      return {};
    }

    const { openId, chatId, messageId } = resolveFeishuCardActionIdentity(data as FeishuCardActionIdentity);
    const actorName = openId ? `openid:${openId.slice(-6)}` : '用户';

    if (cmd === 'workflow-dashboard') {
      const value = data.action.value as Record<string, unknown>;
      if (typeof value.projectId !== 'string'
        || typeof value.jobId !== 'string'
        || typeof value.action !== 'string') return {};
      void handleWorkflowDashboardCardAction({
        projectId: value.projectId,
        jobId: value.jobId,
        action: value.action,
        actorOpenId: openId,
        cardMessageId: messageId,
      }).then((result) => {
        console.log(`${prefix} workflow dashboard action completed`, {
          action: value.action,
          projectId: value.projectId,
          jobId: value.jobId,
          result,
        });
      }).catch((err) => {
        console.error(`${prefix} workflow dashboard action failed`, { err });
        if (chatId) {
          void sendFeishuTextMessage({
            receiveId: chatId,
            receiveIdType: 'chat_id',
            replyId: messageId,
            text: '❌ Workflow Dashboard 操作失败，请稍后重试。',
          }).catch(() => undefined);
        }
      });
      return { toast: { type: 'success', content: '操作已接收；完成后会回复结果并发送最新 Dashboard' } };
    }

    if (cmd === 'ap-command') {
      const value = data.action.value as Record<string, unknown>;
      const commandText = typeof value.command === 'string' ? value.command : '';
      const chatType = value.chatType === 'p2p' ? 'p2p' : 'group';
      if (!openId || !chatId || !FEISHU_COMMAND_CARD_ACTIONS.has(commandText)) {
        return { toast: { type: 'warning', content: '命令卡已失效，请重新发送 /ap menu' } };
      }
      const command = parseFeishuCommand({
        chatId,
        chatType,
        messageId: messageId || '',
        senderOpenId: openId,
        messageType: 'text',
        text: commandText,
        mentions: [],
        mentionNames: [],
      });
      if (!command) return { toast: { type: 'warning', content: '命令卡内容无效' } };
      void handleFeishuCommand({
        command,
        baseUrl: resolveBaseUrl(),
        context: {
          chatId,
          chatType,
          senderOpenId: openId,
          messageId: messageId || '',
        },
      }).then((result) => sendFeishuTextMessage({
        receiveId: chatId,
        receiveIdType: 'chat_id',
        replyId: messageId,
        text: result,
      })).catch((err) => {
        console.error(`${prefix} AP command card action failed`, { command: commandText, err });
        return sendFeishuTextMessage({
          receiveId: chatId,
          receiveIdType: 'chat_id',
          replyId: messageId,
          text: `❌ 命令执行失败：${err instanceof Error ? err.message : String(err)}`,
        });
      });
      return { toast: { type: 'success', content: `${commandText} 已接收，结果稍后回复` } };
    }

    if (cmd === 'workflow-review') {
      const value = data.action.value as Record<string, unknown>;
      const decision = value.decision;
      const formValue = (data.action as unknown as { form_value?: Record<string, unknown> }).form_value;
      const reviewFeedback = typeof formValue?.reviewFeedback === 'string'
        ? formValue.reviewFeedback.trim()
        : '';
      if (!['approve', 'reject', 'revision'].includes(String(decision))
        || typeof value.projectId !== 'string'
        || typeof value.jobId !== 'string'
        || typeof value.pendingKey !== 'string') return {};
      try {
        const result = await resolveWorkflowReviewCardAction({
          projectId: value.projectId,
          jobId: value.jobId,
          pendingKey: value.pendingKey,
          decision: decision as WorkflowReviewDecision,
          actorOpenId: openId,
          messageId,
          reviewAttempt: typeof value.reviewAttempt === 'number' ? value.reviewAttempt : undefined,
          reviewFeedback,
        });
        if (result.status === 'applied' && messageId) {
          await updateFeishuApprovalCardResolved({
            messageId,
            resolution: decision === 'approve'
              ? 'approved'
              : decision === 'revision'
                ? 'revision'
                : 'rejected',
            actorName,
          }).catch((error) => console.error(`${prefix} failed to persist workflow review card result`, error));
        }
        if (result.status === 'applied' && decision !== 'approve') {
          await sendFeishuTextMessage({
            receiveId: result.chatId,
            receiveIdType: 'chat_id',
            text: decision === 'revision'
              ? reviewFeedback
                ? '✏️ PLAN 修改请求已记录，正在通知 Coding Agent 按反馈修订计划。'
                : '✏️ PLAN 修改请求已记录，请回复随后发送的询问消息；收到意见后才会启动 Coding Agent。'
              : '❌ PLAN 已拒绝，workflow-watcher 已立即处理，不会启动新的 Session。',
          }).catch((error) => console.error(`${prefix} failed to send workflow review receipt`, error));
        }
        return {
          toast: {
            type: result.status === 'applied' ? 'success' : 'warning',
            content: result.status === 'applied' ? '审批已记录' : `审批未生效：${result.status}`,
          },
        };
      } catch (err) {
        console.error(`${prefix} workflow review resolution failed`, { err });
        return { toast: { type: 'error', content: '审批处理失败，请稍后重试' } };
      }
    }

    if (cmd === 'workflow-revision-feedback') {
      const value = data.action.value as Record<string, unknown>;
      const formValue = (data.action as unknown as { form_value?: Record<string, unknown> }).form_value;
      const feedback = typeof formValue?.reviewFeedback === 'string'
        ? formValue.reviewFeedback.trim()
        : '';
      if (typeof value.projectId !== 'string'
        || typeof value.jobId !== 'string'
        || typeof value.pendingKey !== 'string') return {};
      if (!feedback) return { toast: { type: 'warning', content: '请填写具体修改意见' } };
      try {
        const result = await resolveWorkflowRevisionFeedbackCardAction({
          projectId: value.projectId,
          jobId: value.jobId,
          pendingKey: value.pendingKey,
          actorOpenId: openId,
          feedback,
        });
        if (result.status === 'applied' && messageId) {
          await updateFeishuApprovalCardResolved({
            messageId,
            resolution: 'revision',
            actorName,
          }).catch((error) => console.error(`${prefix} failed to persist revision feedback card result`, error));
        }
        if (result.status === 'applied') {
          await sendFeishuTextMessage({
            receiveId: result.chatId,
            receiveIdType: 'chat_id',
            text: '✏️ 修改意见已提交，正在通知 Coding Agent 只修订 PLAN。',
          }).catch((error) => console.error(`${prefix} failed to send revision feedback receipt`, error));
        }
        return {
          toast: {
            type: result.status === 'applied' ? 'success' : 'warning',
            content: result.status === 'applied' ? '修改意见已提交' : `提交未生效：${result.status}`,
          },
        };
      } catch (err) {
        console.error(`${prefix} workflow revision feedback failed`, { err });
        return { toast: { type: 'error', content: '修改意见提交失败，请稍后重试' } };
      }
    }

    const approveMatch = /^approve:(.+)$/.exec(cmd);
    const denyMatch = /^deny:(.+)$/.exec(cmd);
    const adminMatch = /^admin-approval:(approve|deny):(.+)$/.exec(cmd);

    if (adminMatch) {
      try {
        const formValue = (data.action as unknown as { form_value?: Record<string, unknown> }).form_value;
        await resolveFeishuAdminApproval({ approvalId: adminMatch[2], approved: adminMatch[1] === 'approve', actorOpenId: openId, cardMessageId: messageId, workspaceRoot: typeof formValue?.workspaceRoot === 'string' ? formValue.workspaceRoot : undefined });
      } catch (err) {
        console.error(`${prefix} admin approval resolution failed`, { approvalId: adminMatch[2], err });
      }
      return {};
    }

    if (!approveMatch && !denyMatch) {
      return {};
    }
    if (!isFeishuAdmin(openId)) {
      const access = openId ? await prisma.feishuUserAccess.findUnique({ where: { openId }, select: { status: true } }) : null;
      if (access?.status !== 'approved') return {};
    }

    const requestId = (approveMatch ?? denyMatch)![1];
    const approved = !!approveMatch;

    try {
      await resolveInteractionRequestWithContinuation({
        requestId,
        action: approved ? 'approve' : 'deny',
        actor: { id: openId || 'feishu_card', name: actorName, channel: 'feishu' },
      });

      if (messageId) {
        await updateFeishuApprovalCardResolved({ messageId, approved, actorName }).catch(() => {});
      }

      console.log(`${prefix} card action resolved`, { requestId, approved, actorName });
    } catch (err) {
      console.error(`${prefix} card action resolution failed`, { requestId, err });
      return {
        toast: {
          type: 'warning',
          content: err instanceof Error ? err.message : '权限卡已失效',
        },
      };
    }

    return {};
  };
}

function attachRuntimeHandlers(prefix: string, host: 'standalone' | 'nextjs') {
  const state = getState();

  return new Lark.EventDispatcher({
    encryptKey: process.env.FEISHU_ENCRYPT_KEY?.trim(),
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN?.trim(),
    loggerLevel: Lark.LoggerLevel.info,
  }).register({
    'card.action.trigger': buildCardActionHandler(prefix),
    'im.message.reaction.created_v1': () => {},
    'im.message.reaction.deleted_v1': () => {},
    'im.message.receive_v1': async (data) => {
      const parsedMessage = parseWsIncomingMessage(data as FeishuWsMessagePayload);
      if (!parsedMessage) {
        console.log(`${prefix} ignored event: parse failed`);
        return;
      }

      markRuntimeStatus(host, {
        status: 'running',
        lastHeartbeatAt: new Date().toISOString(),
      });

      pruneSeenMessageIds(state);
      if (state.messageIds.has(parsedMessage.messageId)) {
        console.log(`${prefix} ignored duplicate`, { messageId: parsedMessage.messageId });
        return;
      }

      const selfOpenId = process.env.FEISHU_BOT_OPEN_ID?.trim();
      if (selfOpenId && parsedMessage.senderOpenId === selfOpenId) {
        console.log(`${prefix} ignored self message`, { messageId: parsedMessage.messageId });
        return;
      }

      if (!await claimFeishuMessage(prisma, parsedMessage.messageId)) {
        state.messageIds.set(parsedMessage.messageId, Date.now());
        console.log(`${prefix} ignored persisted duplicate`, { messageId: parsedMessage.messageId });
        return;
      }
      state.messageIds.set(parsedMessage.messageId, Date.now());

      void (async () => {
        const parentMessageId = parsedMessage.parentId;
        const message = await hydrateFeishuMessageResources(parsedMessage);
        if (!message) {
          console.log(`${prefix} ignored event: resource hydration failed`);
          return;
        }

        if (!await checkFeishuDirectMessageAccess(message)) return;
        const revisionFeedback = await resolveWorkflowRevisionFeedback({
          chatId: message.chatId,
          actorOpenId: message.senderOpenId,
          parentMessageId,
          feedback: message.text,
        });
        if (revisionFeedback.status === 'applied') {
          await sendFeishuTextMessage({
            receiveId: message.chatId,
            receiveIdType: 'chat_id',
            replyId: message.messageId,
            text: '✅ 修改意见已收到，正在通知 Coding Agent 修订 PLAN。',
          });
          return;
        }
        const command = parseFeishuCommand(message);
        if (!command) {
          // Not a /ap command — check if the chat is bound to a live room and relay
          const relayTypingReactionId = await addTypingReaction(message.messageId);
          const relayed = await tryRelayNonCommandToLiveRoom({
            context: {
              chatId: message.chatId,
              chatType: message.chatType,
              senderOpenId: message.senderOpenId,
              messageId: message.messageId,
              mentionNames: message.mentionNames,
            },
            content: message.text,
            typingReactionId: relayTypingReactionId ?? undefined,
          }).catch((err) => {
            console.error(`${prefix} relay non-command failed`, { error: err });
            return false;
          });
          if (!relayed) {
            // No binding found — clean up the typing reaction we already added
            if (relayTypingReactionId) {
              await removeTypingReaction(message.messageId, relayTypingReactionId);
            }
            console.log(`${prefix} ignored non-command (no binding)`, {
              messageId: message.messageId,
              text: message.text,
            });
            if (message.chatType === 'group') {
              await sendFeishuTextMessage({ receiveId: message.chatId, receiveIdType: 'chat_id', replyId: message.messageId, text: UNBOUND_FEISHU_LIVE_ROOM_HINT });
            }
          } else {
            await maybeSendFeishuSessionWatermarkWarning({
              context: {
                chatId: message.chatId,
                chatType: message.chatType,
                senderOpenId: message.senderOpenId,
                messageId: message.messageId,
                mentionNames: message.mentionNames,
              },
              replyId: message.messageId,
            }).catch((warningError) => {
              console.error(`${prefix} session watermark warning failed`, { error: warningError });
            });
          }
          return;
        }

        console.log(`${prefix} command received`, {
          messageId: message.messageId,
          command: command.command,
          args: command.args,
          options: command.options,
        });

        const typingReactionId = await addTypingReaction(message.messageId);

        try {
          const responseText = await handleFeishuCommand({
            command,
            baseUrl: resolveBaseUrl(),
            context: {
              chatId: message.chatId,
              chatType: message.chatType,
              senderOpenId: message.senderOpenId,
              messageId: message.messageId,
              mentionNames: message.mentionNames,
            },
          });

          console.log(`${prefix} command handled`, {
            messageId: message.messageId,
            responsePreview: responseText.slice(0, 200),
          });

          if (typingReactionId) {
            await removeTypingReaction(message.messageId, typingReactionId);
          }

          await sendFeishuTextMessage({
            receiveId: message.chatId,
            receiveIdType: 'chat_id',
            replyId: message.messageId,
            text: responseText,
          });

          console.log(`${prefix} reply sent`, {
            messageId: message.messageId,
            chatId: message.chatId,
          });
        } catch (error) {
          const lastError = error instanceof Error ? error.message : String(error);
          console.error(`${prefix} command failed`, {
            messageId: message.messageId,
            error: lastError,
          });
          if (typingReactionId) {
            await removeTypingReaction(message.messageId, typingReactionId);
          }
          try {
            await sendFeishuTextMessage({
              receiveId: message.chatId,
              receiveIdType: 'chat_id',
              replyId: message.messageId,
              text: `命令执行失败：${lastError}`,
            });
          } catch (replyError) {
            console.error(`${prefix} failed to send error reply`, {
              messageId: message.messageId,
              error: replyError instanceof Error ? replyError.message : String(replyError),
            });
          }
          markRuntimeStatus(host, {
            status: 'error',
            lastError,
            lastHeartbeatAt: new Date().toISOString(),
          });
        }
      })().catch((error) => {
        const lastError = error instanceof Error ? error.message : String(error);
        console.error(`${prefix} background message handling failed`, {
          messageId: parsedMessage.messageId,
          error: lastError,
        });
        markRuntimeStatus(host, {
          status: 'error',
          lastError,
          lastHeartbeatAt: new Date().toISOString(),
        });
      });
      return;
    },
    'im.message.message_read_v1': async () => {
      markRuntimeStatus(host, {
        status: 'running',
        lastHeartbeatAt: new Date().toISOString(),
      });
      console.log(`${prefix} read receipt received`);
    },
  });
}

async function startRuntime(host: 'standalone' | 'nextjs', prefix: string) {
  const state = getState();

  if (!shouldUseLongConnection()) {
    state.status = 'disabled';
    return markRuntimeStatus(host, {
      status: 'disabled',
      startedAt: null,
      lastHeartbeatAt: null,
      lastError: null,
    });
  }

  if (state.status === 'running') {
    return getFeishuLongConnectionStatus();
  }

  if (state.startPromise) {
    await state.startPromise;
    return getFeishuLongConnectionStatus();
  }

  state.status = 'starting';
  state.lastError = undefined;

  markRuntimeStatus(host, {
    status: 'starting',
    startedAt: null,
    lastHeartbeatAt: null,
    lastError: null,
  });

  const startPromise = (async () => {
    // On startup, reset any deliveries/members/participants left in a running/busy
    // state from a previous process that was killed mid-execution.
    try {
      await failAndNotifyInterruptedDeliveries('Stale: runtime restarted');
      await prisma.liveRoomMember.updateMany({
        where: { presenceStatus: 'busy' },
        data: { presenceStatus: 'idle' },
      });
      await prisma.liveRoomMemberSession.updateMany({
        where: { status: 'busy' },
        data: { status: 'online' },
      });

      // Fix stale task run participants: those with session IDs -> completed (eligible for
      // session continuation on the next message); those without -> failed.
      const staleParticipants = await prisma.taskRunParticipant.findMany({
        where: { status: 'running' },
        select: { id: true, controlMetadata: true },
      });
      for (const pt of staleParticipants) {
        let meta: Record<string, unknown> = {};
        try { meta = JSON.parse(pt.controlMetadata || '{}'); } catch { /* ignore */ }
        const hasSession = typeof meta.lastSessionId === 'string' || typeof meta.claudeSessionId === 'string' || typeof meta.codexThreadId === 'string';
        await prisma.taskRunParticipant.update({
          where: { id: pt.id },
          data: hasSession
            ? { status: 'completed', completedAt: new Date(), error: null }
            : { status: 'failed', completedAt: new Date(), error: 'Stale: process killed before session started' },
        });
      }
      // Mark stale task runs as completed (not failed — failed runs are excluded from
      // the continuation session lookup in findLatestParticipantSession).
      await prisma.taskRun.updateMany({
        where: { status: 'running' },
        data: { status: 'completed', completedAt: new Date() },
      });
    } catch (cleanupError) {
      console.warn(`${prefix} startup cleanup failed (non-fatal):`, cleanupError);
    }

    const appId = getRequiredEnv('FEISHU_APP_ID');
    const appSecret = getRequiredEnv('FEISHU_APP_SECRET');
    const eventDispatcher = attachRuntimeHandlers(prefix, host);
    const wsClient = new Lark.WSClient({
      appId,
      appSecret,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.info,
    });

    console.log(`${prefix} starting`, {
      appIdSuffix: appId.slice(-4),
      baseUrl: resolveBaseUrl(),
      node: process.version,
      host,
    });

    await wsClient.start({ eventDispatcher });

    state.status = 'running';
    state.startedAt = new Date().toISOString();

    markRuntimeStatus(host, {
      status: 'running',
      startedAt: state.startedAt,
      lastError: null,
    });

    // Periodic watchdog: reap deliveries stuck in 'running' for > 12 minutes
    // (claude max runtime is 10 min, so any delivery older than 12 min is definitely stale).
    // This handles SIGKILL cases that bypass the SIGTERM handler.
    const STALE_DELIVERY_THRESHOLD_MS = 12 * 60 * 1000;
    const watchdogInterval = setInterval(async () => {
      try {
        const staleAt = new Date(Date.now() - STALE_DELIVERY_THRESHOLD_MS);
        const result = await prisma.liveRoomDelivery.updateMany({
          where: { deliveryStatus: 'running', attemptedAt: { lt: staleAt } },
          data: { deliveryStatus: 'failed', fallbackReason: 'Stale: watchdog timeout', acknowledgedAt: new Date() },
        });
        if (result.count > 0) {
          await prisma.liveRoomMember.updateMany({
            where: { presenceStatus: 'busy' },
            data: { presenceStatus: 'idle' },
          });
          console.warn(`${prefix} watchdog reaped ${result.count} stale deliveries`);
        }
      } catch (watchdogError) {
        console.warn(`${prefix} watchdog error (non-fatal):`, watchdogError);
      }
    }, 5 * 60 * 1000); // check every 5 minutes
    watchdogInterval.unref(); // don't prevent process exit
  })()
    .catch((error) => {
      state.status = 'error';
      state.lastError = error instanceof Error ? error.message : String(error);
      markRuntimeStatus(host, {
        status: 'error',
        lastError: state.lastError,
      });
      throw error;
    })
    .finally(() => {
      state.startPromise = undefined;
    });

  state.startPromise = startPromise;
  await startPromise;
  return getFeishuLongConnectionStatus();
}

export function getFeishuLongConnectionStatus() {
  return readFeishuRuntimeStatus() || getFallbackStatus('standalone');
}

export async function ensureFeishuLongConnectionStarted() {
  return startRuntime('nextjs', '[FeishuNextRuntime]');
}

export async function startFeishuLongConnectionRuntime() {
  return startRuntime('standalone', '[FeishuRuntime]');
}

/**
 * Called on SIGTERM to kill in-flight claude subprocesses and clean up DB
 * before the process exits. Must complete within the systemd TimeoutStopSec window.
 */
export async function shutdownFeishuRuntime() {
  console.log('[FeishuRuntime] shutting down — cleaning up in-flight deliveries...');
  try {
    // Kill any running claude/codex child processes tracked in the process registry
    const { acpxRunningProcesses } = globalThis as unknown as {
      acpxRunningProcesses?: Map<string, { child: { kill: (signal: string) => void } }>;
    };
    if (acpxRunningProcesses) {
      Array.from(acpxRunningProcesses.values()).forEach((entry) => {
        try { entry.child.kill('SIGTERM'); } catch { /* ignore */ }
      });
    }

    // Give child processes a moment to exit and write to DB, then force-clean DB state
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const interrupted = await failAndNotifyInterruptedDeliveries('Stale: runtime shutdown');
    await prisma.liveRoomMember.updateMany({
      where: { presenceStatus: 'busy' },
      data: { presenceStatus: 'idle' },
    });
    await prisma.liveRoomMemberSession.updateMany({
      where: { status: 'busy' },
      data: { status: 'online' },
    });
    if (interrupted > 0) {
      console.log(`[FeishuRuntime] cleaned up ${interrupted} in-flight deliveries on shutdown`);
    }
  } catch (err) {
    console.error('[FeishuRuntime] shutdown cleanup error:', err);
  }
}
