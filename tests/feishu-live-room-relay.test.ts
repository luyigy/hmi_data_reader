import assert from 'node:assert/strict';
import {
  buildAssistantRelayCard,
  extractAssistantRelayImages,
  relayLiveRoomMessageToFeishu,
  selectFeishuRelayBinding,
  shouldRelayLiveRoomMessage,
} from '../src/lib/feishu-live-room-relay';
import * as feishuApiModule from '../src/lib/feishu-api';
import { prisma } from '../src/lib/prisma';
import type { LiveRoomMessagePayload } from '../src/lib/live-room';

const message = (
  messageType: string,
  systemEvent?: string,
  metadata: Record<string, unknown> = {}
): LiveRoomMessagePayload => ({
  id: 'message', roomId: 'room', senderMemberId: null, senderName: 'codex', senderLabel: 'codex',
  senderType: 'system', content: '系统提示：codex 正在处理中：我', messageType,
  visibility: 'room', topicSnapshot: null, createdAt: new Date(0).toISOString(),
  replyToMessageId: null, metadata: systemEvent ? { systemEvent, ...metadata } : null,
});

assert.equal(shouldRelayLiveRoomMessage(message('system', 'member_reply_progress')), false);
assert.equal(shouldRelayLiveRoomMessage(message('system', 'member_reply_progress', {
  harnessType: 'codex', stream: 'stdout',
})), false);
assert.equal(shouldRelayLiveRoomMessage(message('system', 'member_reply_progress', {
  harnessType: 'codex', stream: 'stdout', aggregated: true,
})), false);
assert.equal(shouldRelayLiveRoomMessage(message('system', 'member_reply_progress', {
  harnessType: 'codex', stream: 'stderr', aggregated: true,
})), false);
assert.equal(shouldRelayLiveRoomMessage(message('system', 'member_reply_progress', {
  harnessType: 'claude', stream: 'stdout', aggregated: true,
})), false);
assert.equal(shouldRelayLiveRoomMessage(message('system', 'member_reply_progress', {
  harnessType: 'claude', progressKind: 'heartbeat',
})), true);
assert.equal(shouldRelayLiveRoomMessage(message('system', 'member_reply_thinking')), false);
assert.equal(shouldRelayLiveRoomMessage(message('system', 'member_reply_started', { skipFeishuRelay: true })), false);
assert.equal(shouldRelayLiveRoomMessage(message('system', 'member_reply_progress', {
  harnessType: 'claude', progressKind: 'heartbeat', skipFeishuRelay: true,
})), false);
assert.equal(shouldRelayLiveRoomMessage(message('system', 'member_reply_started')), true);
assert.equal(shouldRelayLiveRoomMessage(message('system', 'member_reply_queued')), true);
assert.equal(shouldRelayLiveRoomMessage(message('system', 'member_reply_tool')), false);
assert.equal(shouldRelayLiveRoomMessage(message('system', 'session_reset')), true);
assert.equal(shouldRelayLiveRoomMessage(message('assistant')), true);

const assistant = message('assistant');
assistant.content = '**Done**\n\n- one\n- two';
assert.deepEqual(buildAssistantRelayCard(assistant), {
  config: { wide_screen_mode: true },
  header: {
    template: 'blue',
    title: { tag: 'plain_text', content: 'codex' },
  },
  elements: [{ tag: 'markdown', content: '**Done**\n\n- one\n- two' }],
});

assistant.metadata = { deliveryIntent: 'directed_visible', targetMemberName: 'Claude' };
assert.equal(
  (buildAssistantRelayCard(assistant).header.title as { content: string }).content,
  'Direct/私聊回复 · codex → Claude'
);

assistant.visibility = 'directed_visible';
assistant.metadata = { targetMemberName: 'Claude' };
assert.equal(buildAssistantRelayCard(assistant).header.title.content, 'codex');

assistant.metadata = { deliveryIntent: 'invalid', targetMemberName: 'Claude' };
assert.equal(buildAssistantRelayCard(assistant).header.title.content, 'codex');

assistant.metadata = { deliveryIntent: 'directed_visible' };
assert.equal(buildAssistantRelayCard(assistant).header.title.content, 'codex');

assistant.metadata = { deliveryIntent: 'handoff', targetMemberName: 'Claude' };
assert.deepEqual(buildAssistantRelayCard(assistant), {
  config: { wide_screen_mode: true },
  header: {
    template: 'blue',
    title: { tag: 'plain_text', content: 'codex' },
  },
  elements: [
    { tag: 'markdown', content: '**Done**\n\n- one\n- two' },
    {
      tag: 'note',
      elements: [{ tag: 'plain_text', content: '下一位：Claude' }],
    },
  ],
});

assistant.metadata = { deliveryIntent: 'handoff' };
assert.deepEqual(buildAssistantRelayCard(assistant).elements, [
  { tag: 'markdown', content: '**Done**\n\n- one\n- two' },
]);

assistant.metadata = { deliveryIntent: 'broadcast', handoffRootMessageId: 'root-message' };
assert.deepEqual(buildAssistantRelayCard(assistant).elements, [
  { tag: 'markdown', content: '**Done**\n\n- one\n- two' },
]);

assistant.metadata = { deliveryIntent: 'broadcast', handoffRootMessageId: 'root-message', chainDepth: 1 };
assert.deepEqual(buildAssistantRelayCard(assistant).elements.slice(-2), [{
  tag: 'note',
  elements: [{ tag: 'plain_text', content: '范围：本轮根消息及同一 Handoff 接力链；不含房间全部历史或其他讨论。' }],
}, {
  tag: 'action',
  actions: [{
    tag: 'button',
    type: 'primary',
    text: { tag: 'plain_text', content: '将本轮 Handoff 链生成审批 PLAN' },
    value: {
      cmd: 'handoff-plan',
      roomId: 'room',
      rootMessageId: 'root-message',
      chatType: 'group',
    },
  }],
}]);

assistant.content = '普通引用 @Claude';
assistant.metadata = { deliveryIntent: 'broadcast', targetMemberName: 'Claude' };
assert.equal(buildAssistantRelayCard(assistant).header.title.content, 'codex');

const bindings = [
  { id: 'binding-a', chatId: 'chat-a', chatType: 'group', latestMessageId: null, typingReactionId: null, typingForMessageId: null, liveRoomId: 'room' },
  { id: 'binding-b', chatId: 'chat-b', chatType: 'group', latestMessageId: null, typingReactionId: null, typingForMessageId: null, liveRoomId: 'room' },
];
const routed = message('assistant');
routed.metadata = { feishuBindingId: 'binding-b', feishuChatId: 'chat-b' };
assert.equal(selectFeishuRelayBinding(bindings, routed)?.chatId, 'chat-b');
routed.metadata = null;
assert.equal(selectFeishuRelayBinding(bindings, routed), null, 'shared room must not guess a binding');
assert.equal(selectFeishuRelayBinding(bindings.slice(0, 1), routed)?.chatId, 'chat-a');

assert.deepEqual(
  extractAssistantRelayImages(
    '扫码：\n![登录二维码](/workspace/login.png)\n![远程图片](https://example.com/image.png)',
    '/workspace'
  ),
  {
    text: '扫码：\n登录二维码\n[远程图片](https://example.com/image.png)',
    imagePaths: ['/workspace/login.png'],
  }
);
assert.deepEqual(
  extractAssistantRelayImages('![密钥](/etc/passwd)', '/workspace'),
  {
    text: '密钥（图片路径不在工作区）',
    imagePaths: [],
  }
);

const checkInteractiveFallback = async () => {
  const feishuApi = feishuApiModule as {
    sendFeishuInteractiveMessage: typeof feishuApiModule.sendFeishuInteractiveMessage;
    sendFeishuTextMessage: typeof feishuApiModule.sendFeishuTextMessage;
  };
  const originalQueryRaw = prisma.$queryRaw;
  const originalInteractive = feishuApi.sendFeishuInteractiveMessage;
  const originalText = feishuApi.sendFeishuTextMessage;
  const sentTexts: string[] = [];

  prisma.$queryRaw = (async () => [bindings[0]]) as typeof prisma.$queryRaw;
  feishuApi.sendFeishuInteractiveMessage = async () => {
    throw new Error('card contains unresolved variable');
  };
  feishuApi.sendFeishuTextMessage = async ({ text }) => {
    sentTexts.push(text);
  };

  try {
    assistant.content = 'Key: ${cursor}:${head}:${reason}';
    await relayLiveRoomMessageToFeishu(assistant);
    assert.deepEqual(sentTexts, ['codex\n\nKey: ${cursor}:${head}:${reason}']);
  } finally {
    prisma.$queryRaw = originalQueryRaw;
    feishuApi.sendFeishuInteractiveMessage = originalInteractive;
    feishuApi.sendFeishuTextMessage = originalText;
  }
};

void checkInteractiveFallback()
  .then(() => console.log('Feishu Live Room relay checks passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
