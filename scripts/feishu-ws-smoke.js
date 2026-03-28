const Lark = require('@larksuiteoapi/node-sdk');

function getRequiredEnv(name) {
  const value = process.env[name] && process.env[name].trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main() {
  const appId = getRequiredEnv('FEISHU_APP_ID');
  const appSecret = getRequiredEnv('FEISHU_APP_SECRET');
  const durationMs = Number(process.env.FEISHU_SMOKE_DURATION_MS || '30000');

  const eventDispatcher = new Lark.EventDispatcher({
    encryptKey: process.env.FEISHU_ENCRYPT_KEY && process.env.FEISHU_ENCRYPT_KEY.trim(),
    verificationToken:
      process.env.FEISHU_VERIFICATION_TOKEN && process.env.FEISHU_VERIFICATION_TOKEN.trim(),
    loggerLevel: Lark.LoggerLevel.info,
  });

  const logEvent = (eventType) => async (data) => {
    const header = data && data.header;
    const message = data && data.message;
    console.log(`[Smoke] received ${eventType}`, {
      headerEventType: header && header.event_type ? header.event_type : null,
      headerMessageId: header && header.message_id ? header.message_id : null,
      headerEventId: header && header.event_id ? header.event_id : null,
      chatId: message && message.chat_id ? message.chat_id : null,
      messageId: message && message.message_id ? message.message_id : null,
      messageType: message && message.message_type ? message.message_type : null,
      topLevelKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 12) : [],
    });
  };

  eventDispatcher.register({
    'im.message.receive_v1': logEvent('im.message.receive_v1'),
    'im.message.message_read_v1': logEvent('im.message.message_read_v1'),
    'im.chat.member.bot.added_v1': logEvent('im.chat.member.bot.added_v1'),
    'im.chat.member.bot.deleted_v1': logEvent('im.chat.member.bot.deleted_v1'),
    'im.message.reaction.created_v1': logEvent('im.message.reaction.created_v1'),
    'im.message.reaction.deleted_v1': logEvent('im.message.reaction.deleted_v1'),
    'card.action.trigger': logEvent('card.action.trigger'),
  });

  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.info,
  });

  console.log('[Smoke] starting WSClient', {
    appIdSuffix: appId.slice(-4),
    durationMs,
    node: process.version,
  });

  await wsClient.start({ eventDispatcher });
  console.log('[Smoke] WSClient started');

  setTimeout(() => {
    console.log('[Smoke] timeout reached, exiting');
    process.exit(0);
  }, durationMs);
}

main().catch((error) => {
  console.error('[Smoke] failed', error);
  process.exit(1);
});
