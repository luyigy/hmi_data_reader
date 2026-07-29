import assert from 'node:assert/strict';
import {
  buildAssistantRelayCard,
  selectFeishuRelayBinding,
  shouldRelayLiveRoomMessage,
} from '../src/lib/feishu-live-room-relay';
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
assert.equal(shouldRelayLiveRoomMessage(message('system', 'member_reply_started')), true);
assert.equal(shouldRelayLiveRoomMessage(message('system', 'member_reply_queued')), true);
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
  'codex → Claude'
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
