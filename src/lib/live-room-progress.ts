import type { HarnessStreamCallbacks } from '@/lib/acpx/types';
import {
  PROGRESS_HEARTBEAT_MS,
  PROGRESS_THINKING_MIN_MS,
  PROGRESS_TOOL_MIN_MS,
} from '@/lib/acpx/harness-events';
import { FeishuProgressTracker } from '@/lib/feishu-progress';
import {
  parseLiveRoomMessageMetadata,
  postLiveRoomMessage,
  resolveLiveRoomMessageMetadata,
} from '@/lib/live-room';
import { prisma } from '@/lib/prisma';

export const shouldRelayLiveRoomStdoutProgress = (harnessType: string | null) =>
  ['codex', 'kimi-code', 'pi-agent', 'antigravity'].includes(harnessType || '');

export const isUsefulLiveRoomThinkingPreview = (text: string) =>
  text.length >= 80 || /[.!?。！？]\s*$/.test(text);

export const attachLiveRoomProgress = async ({
  room,
  participant,
  sourceMessage,
}: {
  room: { id: string };
  participant: { id: string; displayName: string; harnessType: string | null };
  sourceMessage: { metadata?: string | null };
}) => {
  const sourceMetadata = parseLiveRoomMessageMetadata(sourceMessage.metadata);
  const metadataChatId = typeof sourceMetadata?.feishuChatId === 'string'
    ? sourceMetadata.feishuChatId
    : null;
  // Prefer the exact binding recorded on the inbound message; a metadata id from
  // another room must never redirect this room's progress output.
  const metadataBindingId = typeof sourceMetadata?.feishuBindingId === 'string'
    ? sourceMetadata.feishuBindingId
    : null;
  let originBinding: { chatId: string; threadId: string | null; rootMessageId: string | null } | null = null;
  if (metadataBindingId) {
    const byId = await prisma.feishuConversationBinding.findUnique({
      where: { id: metadataBindingId },
      select: { chatId: true, threadId: true, rootMessageId: true, liveRoomId: true },
    });
    if (byId && byId.liveRoomId === room.id) originBinding = { chatId: byId.chatId, threadId: byId.threadId, rootMessageId: byId.rootMessageId };
  }
  if (!originBinding) {
    const bindingRows = await prisma.$queryRaw<Array<{ chatId: string; threadId: string | null; rootMessageId: string | null }>>`
      SELECT "chatId", "threadId", "rootMessageId" FROM "FeishuConversationBinding"
      WHERE "liveRoomId" = ${room.id}
      LIMIT 1
    `;
    originBinding = bindingRows[0] || null;
  }
  const progressTracker = originBinding || metadataChatId
    ? new FeishuProgressTracker({
        chatId: originBinding?.chatId || metadataChatId!,
        threadId: originBinding?.threadId ?? null,
        rootMessageId: originBinding?.rootMessageId ?? null,
      })
    : null;
  const relayOrigin = {
    feishuBindingId: sourceMetadata?.feishuBindingId,
    feishuChatId: sourceMetadata?.feishuChatId,
  };
  let flushPromise: Promise<void> = Promise.resolve();
  let lastToolSignature = '';
  let lastToolPostedAt = 0;
  let lastVisibleActivityAt = Date.now();
  let lastThinkingPostedAt = 0;
  let lastThinkingPreview = '';
  let pendingThinkingText = '';

  const postProgress = (content: string, systemEvent: string, extras: Record<string, unknown>) => {
    flushPromise = flushPromise.then(() => postLiveRoomMessage({
      roomId: room.id,
      content,
      messageType: 'system',
      metadata: resolveLiveRoomMessageMetadata({
        senderKind: 'system',
        targetMemberId: participant.id,
        extras: { ...relayOrigin, systemEvent, harnessType: participant.harnessType, ...extras },
      }),
    }).then(() => undefined)).catch((error) => {
      console.error('Failed to post live room progress update:', error);
    });
  };

  const enqueueThinkingUpdate = (chunk: string) => {
    const isCodex = participant.harnessType === 'codex';
    const text = isCodex ? (pendingThinkingText += chunk).trim() : chunk.trim();
    const preview = text.slice(0, 80);
    if (!preview || (isCodex && !isUsefulLiveRoomThinkingPreview(text))) return;
    const now = Date.now();
    if (now - lastThinkingPostedAt < PROGRESS_THINKING_MIN_MS) return;
    if (preview === lastThinkingPreview) {
      pendingThinkingText = '';
      return;
    }
    lastThinkingPreview = preview;
    lastThinkingPostedAt = now;
    lastVisibleActivityAt = now;
    pendingThinkingText = '';
    progressTracker?.onSystemEvent(`思考分析：${preview}`, '🧠');
    postProgress(
      `系统提示：${participant.displayName} 正在分析：${preview}${text.length > 80 ? '…' : ''}`,
      'member_reply_thinking',
      { preview, ...(progressTracker ? { skipFeishuRelay: true } : {}) },
    );
  };

  const enqueueToolUpdate = (event: { toolName: string; preview: string; emoji: string }) => {
    const preview = event.preview.trim();
    const signature = `${event.toolName}:${preview}`;
    const now = Date.now();
    if (now - lastToolPostedAt < PROGRESS_TOOL_MIN_MS || signature === lastToolSignature) return;
    lastToolSignature = signature;
    lastToolPostedAt = now;
    lastVisibleActivityAt = now;
    progressTracker?.onToolEvent(event.toolName, preview, event.emoji);
    postProgress(
      `系统提示：${participant.displayName} 正在使用 ${event.toolName}${preview ? `：${preview}` : ''}`,
      'member_reply_tool',
      {
        toolName: event.toolName,
        toolEmoji: event.emoji,
        preview,
        ...(progressTracker ? { skipFeishuRelay: true } : {}),
      },
    );
  };

  const streamCallbacks: HarnessStreamCallbacks = {
    ...(shouldRelayLiveRoomStdoutProgress(participant.harnessType)
      ? { onStdoutChunk: enqueueThinkingUpdate }
      : {}),
    onToolEvent: enqueueToolUpdate,
    onSubagentEvent: (event) => {
      lastVisibleActivityAt = Date.now();
      const duration = event.startedAt && event.endedAt
        ? `，耗时 ${Math.max(0, event.endedAt - event.startedAt)}ms`
        : '';
      const output = event.output?.trim();
      const count = event.ordinal && event.limit ? ` ${event.ordinal}/${event.limit}` : '';
      postProgress(
        `系统提示：${participant.displayName} 的 SubAgent${count} ${event.agentId || event.taskId} ${event.status}：${event.description}${duration}${output ? `\n\n${output}` : ''}`,
        'member_reply_subagent',
        {
          subagentTaskId: event.taskId,
          subagentId: event.agentId,
          subagentStatus: event.status,
          subagentType: event.subagentType,
          subagentModel: event.model,
          preview: event.description,
        },
      );
    },
  };
  const heartbeatTimer = setInterval(() => {
    if (Date.now() - lastVisibleActivityAt < PROGRESS_HEARTBEAT_MS) return;
    lastVisibleActivityAt = Date.now();
    progressTracker?.onSystemEvent('心跳保活：当前步骤耗时较长，持续处理中...', '💓');
    postProgress(
      `系统提示：${participant.displayName} 仍在处理中，当前步骤耗时较长。`,
      'member_reply_progress',
      { progressKind: 'heartbeat', preview: '当前步骤耗时较长', ...(progressTracker ? { skipFeishuRelay: true } : {}) },
    );
  }, PROGRESS_HEARTBEAT_MS);
  heartbeatTimer.unref();

  progressTracker?.onSystemEvent(`开始处理消息 | ${participant.displayName} (${participant.harnessType})`, '🚀');

  return {
    streamCallbacks,
    progressTracker,
    dispose: async (summary: string, success: boolean) => {
      clearInterval(heartbeatTimer);
      await flushPromise.catch(() => undefined);
      await progressTracker?.finalize(summary, success).catch(() => undefined);
    },
  };
};
