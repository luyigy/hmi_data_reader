const path = require('path');
const Module = require('module');
const Lark = require('@larksuiteoapi/node-sdk');

require('ts-node').register({
  transpileOnly: true,
  compilerOptions: {
    module: 'commonjs',
    moduleResolution: 'node',
    esModuleInterop: true,
    allowJs: true,
  },
});

const projectRoot = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
  if (typeof request === 'string' && request.startsWith('@/')) {
    const mapped = path.join(projectRoot, 'src', request.slice(2));
    return originalResolveFilename.call(this, mapped, parent, isMain, options);
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const {
  handleFeishuCommand,
  parseFeishuCommand,
  sendFeishuTextMessage,
} = require(path.join(projectRoot, 'src/lib/feishu.ts'));

function getRequiredEnv(name) {
  const value = process.env[name] && process.env[name].trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function resolveBaseUrl() {
  return process.env.AGENT_PLATFORM_BASE_URL && process.env.AGENT_PLATFORM_BASE_URL.trim()
    ? process.env.AGENT_PLATFORM_BASE_URL.trim()
    : 'http://127.0.0.1:3010';
}

function parseWsIncomingMessage(payload) {
  const message = payload && payload.message;
  const senderOpenId = payload && payload.sender && payload.sender.sender_id && payload.sender.sender_id.open_id;
  if (!message || !message.chat_id || !message.message_id || !message.content || !senderOpenId) {
    return null;
  }

  let text = '';
  try {
    const content = JSON.parse(message.content);
    text = (content && content.text && content.text.trim()) || '';
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
    mentions: Array.isArray(message.mentions)
      ? message.mentions
          .map((mention) => mention && mention.id && mention.id.open_id)
          .filter(Boolean)
      : [],
  };
}

function createSeenMessageStore() {
  const messageIds = new Map();
  return {
    has(messageId) {
      return messageIds.has(messageId);
    },
    add(messageId) {
      messageIds.set(messageId, Date.now());
      const now = Date.now();
      for (const [key, timestamp] of Array.from(messageIds.entries())) {
        if (now - timestamp > 10 * 60 * 1000) {
          messageIds.delete(key);
        }
      }
    },
  };
}

async function main() {
  const appId = getRequiredEnv('FEISHU_APP_ID');
  const appSecret = getRequiredEnv('FEISHU_APP_SECRET');
  const seen = createSeenMessageStore();

  process.on('unhandledRejection', (error) => {
    console.error('[FeishuStandalone] unhandledRejection', error);
  });
  process.on('uncaughtException', (error) => {
    console.error('[FeishuStandalone] uncaughtException', error);
  });

  const eventDispatcher = new Lark.EventDispatcher({
    encryptKey: process.env.FEISHU_ENCRYPT_KEY && process.env.FEISHU_ENCRYPT_KEY.trim(),
    verificationToken:
      process.env.FEISHU_VERIFICATION_TOKEN && process.env.FEISHU_VERIFICATION_TOKEN.trim(),
    loggerLevel: Lark.LoggerLevel.info,
  }).register({
    'im.message.receive_v1': async (data) => {
      const message = parseWsIncomingMessage(data);
      if (!message) {
        console.log('[FeishuStandalone] ignored event: parse failed');
        return;
      }

      if (seen.has(message.messageId)) {
        console.log('[FeishuStandalone] ignored duplicate', { messageId: message.messageId });
        return;
      }
      seen.add(message.messageId);

      const selfOpenId = process.env.FEISHU_BOT_OPEN_ID && process.env.FEISHU_BOT_OPEN_ID.trim();
      if (selfOpenId && message.senderOpenId === selfOpenId) {
        console.log('[FeishuStandalone] ignored self message', { messageId: message.messageId });
        return;
      }

      const command = parseFeishuCommand(message);
      if (!command) {
        console.log('[FeishuStandalone] ignored non-command', {
          messageId: message.messageId,
          text: message.text,
        });
        return;
      }

      console.log('[FeishuStandalone] command received', {
        messageId: message.messageId,
        command: command.command,
        args: command.args,
        options: command.options,
      });

      try {
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

        console.log('[FeishuStandalone] command handled', {
          messageId: message.messageId,
          responsePreview: responseText.slice(0, 200),
        });

        await sendFeishuTextMessage({
          receiveId: message.chatId,
          receiveIdType: 'chat_id',
          replyId: message.messageId,
          text: responseText,
        });

        console.log('[FeishuStandalone] reply sent', {
          messageId: message.messageId,
          chatId: message.chatId,
        });
      } catch (error) {
        console.error('[FeishuStandalone] command failed', {
          messageId: message.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    'im.message.message_read_v1': async () => {
      console.log('[FeishuStandalone] read receipt received');
    },
  });

  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.info,
  });

  console.log('[FeishuStandalone] starting', {
    appIdSuffix: appId.slice(-4),
    baseUrl: resolveBaseUrl(),
    node: process.version,
  });

  await wsClient.start({ eventDispatcher });
  console.log('[FeishuStandalone] started');
}

main().catch((error) => {
  console.error('[FeishuStandalone] failed to start', error);
  process.exit(1);
});
