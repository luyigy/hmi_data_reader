import * as Lark from '@larksuiteoapi/node-sdk';
import {
  handleFeishuCommand,
  parseFeishuCommand,
  sendFeishuTextMessage,
} from '@/lib/feishu';

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
    content?: string;
    mentions?: Array<{
      id?: {
        open_id?: string;
      };
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

  let text = '';
  try {
    const content = JSON.parse(message.content) as { text?: string };
    text = content.text?.trim() || '';
  } catch {
    return null;
  }

  if (!text) {
    return null;
  }

  return {
    chatId: message.chat_id,
    chatType: message.chat_type || 'group',
    messageId: message.message_id,
    senderOpenId,
    text,
    mentions: (message.mentions || [])
      .map((mention) => mention.id?.open_id)
      .filter((value): value is string => !!value),
  };
}

export function getFeishuLongConnectionStatus() {
  const state = getState();
  return {
    status: state.status,
    startedAt: state.startedAt || null,
    lastError: state.lastError || null,
    mode: process.env.FEISHU_CONNECTION_MODE?.trim() || 'long_connection',
  };
}

export async function ensureFeishuLongConnectionStarted() {
  const state = getState();

  if (!shouldUseLongConnection()) {
    state.status = 'disabled';
    return getFeishuLongConnectionStatus();
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

  const startPromise = (async () => {
    const appId = getRequiredEnv('FEISHU_APP_ID');
    const appSecret = getRequiredEnv('FEISHU_APP_SECRET');

    const eventDispatcher = new Lark.EventDispatcher({
      encryptKey: process.env.FEISHU_ENCRYPT_KEY?.trim(),
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN?.trim(),
      loggerLevel: Lark.LoggerLevel.info,
    }).register({
      'im.message.receive_v1': async (data) => {
        const message = parseWsIncomingMessage(data as FeishuWsMessagePayload);
        if (!message) {
          return;
        }

        pruneSeenMessageIds(state);
        if (state.messageIds.has(message.messageId)) {
          return;
        }
        state.messageIds.set(message.messageId, Date.now());

        const selfOpenId = process.env.FEISHU_BOT_OPEN_ID?.trim();
        if (selfOpenId && message.senderOpenId === selfOpenId) {
          return;
        }

        const command = parseFeishuCommand(message);
        if (!command) {
          return;
        }

        const responseText = await handleFeishuCommand({
          command,
          baseUrl: resolveBaseUrl(),
          context: {
            chatId: message.chatId,
            chatType: message.chatType,
            senderOpenId: message.senderOpenId,
            messageId: message.messageId,
          },
        });

        await sendFeishuTextMessage({
          receiveId: message.chatId,
          receiveIdType: 'chat_id',
          replyId: message.messageId,
          text: responseText,
        });
      },
    });

    const wsClient = new Lark.WSClient({
      appId,
      appSecret,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.info,
    });

    await wsClient.start({ eventDispatcher });

    state.status = 'running';
    state.startedAt = new Date().toISOString();
  })()
    .catch((error) => {
      state.status = 'error';
      state.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    })
    .finally(() => {
      state.startPromise = undefined;
    });

  state.startPromise = startPromise;
  await startPromise;
  return getFeishuLongConnectionStatus();
}
