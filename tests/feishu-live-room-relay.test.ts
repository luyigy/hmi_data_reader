import assert from 'node:assert/strict';
import { shouldRelayLiveRoomMessage } from '../src/lib/feishu-live-room-relay';
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
assert.equal(shouldRelayLiveRoomMessage(message('assistant')), true);
