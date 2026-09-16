import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldTriggerFeishuMessage } from '../src/lib/feishu-message-trigger';
import { parseFeishuMessage } from '../src/lib/feishu-webhook';

const botId = 'ou_local_bot';
const originalBotId = process.env.FEISHU_BOT_OPEN_ID;
try {
  delete process.env.FEISHU_BOT_OPEN_ID;
  assert.equal(shouldTriggerFeishuMessage({ chatType: 'group', mentions: [botId] }), false);
  process.env.FEISHU_BOT_OPEN_ID = ` ${botId} `;
  assert.equal(shouldTriggerFeishuMessage({ chatType: 'group', mentions: [botId] }), true);
} finally {
  if (originalBotId === undefined) delete process.env.FEISHU_BOT_OPEN_ID;
  else process.env.FEISHU_BOT_OPEN_ID = originalBotId;
}
for (const [chatType, mentions, identity, expected] of [
  ['group', [], botId, false],
  ['group', ['ou_other_bot'], botId, false],
  ['group', ['all'], botId, false],
  ['group', [botId], botId, true],
  ['group', ['ou_other_bot', botId], botId, true],
  ['group', [botId], '', false],
  ['p2p', [], botId, true],
  ['p2p', [], '', true],
  ['unknown', [botId], botId, false],
] as const) {
  assert.equal(shouldTriggerFeishuMessage({ chatType, mentions: [...mentions] }, identity), expected);
}

// Exercise the event parser: text, names and command syntax cannot stand in for mentions.
for (const text of ['普通聊天', '@本地AI助手 测试', '/ap help']) {
  for (const openId of [undefined, 'ou_other_bot', botId]) {
    const message = parseFeishuMessage({
      header: { event_type: 'im.message.receive_v1' },
      event: {
        sender: { sender_id: { open_id: 'ou_user' } },
        message: {
          chat_id: 'oc_group', chat_type: 'group', message_id: 'om_test',
          message_type: 'text', content: JSON.stringify({ text }),
          mentions: openId ? [{ id: { open_id: openId }, name: '本地AI助手' }] : [],
        },
      },
    });
    assert.ok(message);
    assert.equal(shouldTriggerFeishuMessage(message, botId), openId === botId);
  }
}

// Both entry points must filter before downloading attachments or causing side effects.
for (const file of ['src/lib/feishu-long-connection.ts', 'src/app/api/feishu/webhook/route.ts']) {
  const source = readFileSync(file, 'utf8');
  const guard = source.indexOf('if (!shouldTriggerFeishuMessage(parsedMessage))');
  assert.ok(guard > 0, `${file}: missing trigger guard`);
  for (const call of ['hydrateFeishuMessageResources(parsedMessage)', 'checkFeishuDirectMessageAccess(message)', 'tryRelayNonCommandToLiveRoom({']) {
    assert.ok(source.indexOf(call) > guard, `${file}: ${call} must follow the guard`);
  }
}
console.log('Feishu message trigger checks passed');
