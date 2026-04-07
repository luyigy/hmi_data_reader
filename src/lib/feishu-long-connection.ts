import * as Lark from '@larksuiteoapi/node-sdk';
import {
  hydrateFeishuMessageResources,
  handleFeishuCommand,
  parseFeishuCommand,
  parseFeishuMessageContent,
} from '@/lib/feishu';
import { addTypingReaction, removeTypingReaction, sendFeishuTextMessage } from '@/lib/feishu-api';
import { tryRelayNonCommandToLiveRoom } from '@/lib/feishu-live-room';
import {
  createFeishuRuntimeStatus,
  readFeishuRuntimeStatus,
  updateFeishuRuntimeStatus,
} from '@/lib/feishu-runtime-status';
import { maybeSendFeishuSessionWatermarkWarning } from '@/lib/feishu-session-continuity';

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
    senderOpenId,
    messageType: parsedContent.messageType,
    text: parsedContent.text,
    fileKey: parsedContent.fileKey,
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

function attachRuntimeHandlers(prefix: string, host: 'standalone' | 'nextjs') {
  const state = getState();

  return new Lark.EventDispatcher({
    encryptKey: process.env.FEISHU_ENCRYPT_KEY?.trim(),
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN?.trim(),
    loggerLevel: Lark.LoggerLevel.info,
  }).register({
    'im.message.receive_v1': async (data) => {
      const parsedMessage = parseWsIncomingMessage(data as FeishuWsMessagePayload);
      const message = parsedMessage
        ? await hydrateFeishuMessageResources(parsedMessage)
        : null;
      if (!message) {
        console.log(`${prefix} ignored event: parse failed`);
        return;
      }

      markRuntimeStatus(host, {
        status: 'running',
        lastHeartbeatAt: new Date().toISOString(),
      });

      pruneSeenMessageIds(state);
      if (state.messageIds.has(message.messageId)) {
        console.log(`${prefix} ignored duplicate`, { messageId: message.messageId });
        return;
      }
      state.messageIds.set(message.messageId, Date.now());

      const selfOpenId = process.env.FEISHU_BOT_OPEN_ID?.trim();
      if (selfOpenId && message.senderOpenId === selfOpenId) {
        console.log(`${prefix} ignored self message`, { messageId: message.messageId });
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
