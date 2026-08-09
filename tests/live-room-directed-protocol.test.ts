import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildLiveRoomContinuationMessage,
  buildLiveRoomControlManual,
  stripLeadingMentionForTarget,
} from '../src/lib/live-room-protocol';
import { inferDirectedVisibleRelayTargets } from '../src/lib/live-room-delivery-routing';

const manual = buildLiveRoomControlManual({
  replyableMemberLabels: ['claude', 'antigravity'],
  replyableMemberTokens: ['$claude', '$antigravity'],
  directedTargetAlias: 'claude',
  directedTargetDisplayName: 'claude',
});

assert.match(manual, /Do not use spawn_agent, send_message/);
assert.match(manual, /`@member` is a visible reference only/);
assert.doesNotMatch(manual, /`\$member`/);
assert.match(manual, /canonical handoff token from the list below/);
assert.match(manual, /Never hand off to yourself/);
assert.match(manual, /Structured \/ap plan and \/run workflows keep their orchestrated order/);
assert.match(manual, /use \$claude once/);
assert.match(manual, /Canonical handoff tokens: \$claude, \$antigravity/);
assert.match(
  fs.readFileSync('src/lib/live-room-delivery-execution.ts', 'utf8'),
  /member\.canReply && member\.id !== currentMemberId/,
);
assert.match(buildLiveRoomContinuationMessage(manual, '让 Claude 测试'), /Live room turn protocol[\s\S]*让 Claude 测试/);
assert.equal(
  stripLeadingMentionForTarget({
    content: '$claude 请复核这个根因判断',
    targetDisplayName: 'claude',
  }),
  '请复核这个根因判断'
);
assert.equal(
  stripLeadingMentionForTarget({
    content: '$lag，你和 pi 接力讨论',
    targetDisplayName: 'antigravity',
    targetAliases: ['lag'],
  }),
  '你和 pi 接力讨论',
);

const room = {
  id: 'room',
  title: 'room',
  currentTopic: null,
  mode: 'discussion',
  currentSpeakerMemberId: null,
  members: ['a', 'b', 'c'].map((id) => ({
    id,
    canReply: true,
    displayName: id.toUpperCase(),
    backend: 'platform_local',
    harnessType: 'codex',
    runtimeAgentId: null,
    gatewayId: null,
  })),
};
assert.deepEqual(
  inferDirectedVisibleRelayTargets({
    room,
    sourceMessage: {
      content: '$A 请 B、C 依次讨论',
      metadata: JSON.stringify({ mentionedMemberIds: ['a', 'b', 'c'] }),
      senderMember: { id: 'user', displayName: 'User', memberType: 'user' },
    },
    currentTargetMember: room.members[0],
  }).map((member) => member.id),
  ['b', 'c'],
);
assert.deepEqual(
  inferDirectedVisibleRelayTargets({
    room: {
      ...room,
      members: room.members.map((member) => member.id === 'a' ? { ...member, shortAlias: 'lag' } : member),
    },
    sourceMessage: {
      content: '$lag，你和 B、C 依次讨论',
      metadata: JSON.stringify({ mentionedMemberIds: ['a'] }),
      senderMember: { id: 'user', displayName: 'User', memberType: 'user' },
    },
    currentTargetMember: { ...room.members[0], shortAlias: 'lag' },
  }).map((member) => member.id),
  ['b', 'c'],
);
assert.deepEqual(
  inferDirectedVisibleRelayTargets({
    room,
    sourceMessage: {
      content: 'B 的上一轮输入',
      metadata: JSON.stringify({ handoffRemainingMemberIds: ['c'] }),
      senderMember: { id: 'a', displayName: 'A', memberType: 'agent' },
    },
    currentTargetMember: room.members[1],
  }).map((member) => member.id),
  ['c'],
);
