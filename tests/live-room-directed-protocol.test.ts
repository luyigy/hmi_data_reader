import assert from 'node:assert/strict';
import {
  buildLiveRoomContinuationMessage,
  buildLiveRoomControlManual,
  stripLeadingMentionForTarget,
} from '../src/lib/live-room-protocol';

const manual = buildLiveRoomControlManual({
  replyableMemberLabels: ['claude', 'antigravity'],
  directedTargetAlias: 'claude',
  directedTargetDisplayName: 'claude',
});

assert.match(manual, /Do not use spawn_agent, send_message/);
assert.match(manual, /`@member` is a visible reference only/);
assert.match(manual, /exactly one `\$member` requests an asynchronous handoff/);
assert.match(manual, /Structured \/ap plan and \/run workflows keep their orchestrated order/);
assert.match(manual, /use \$claude once/);
assert.match(buildLiveRoomContinuationMessage(manual, '让 Claude 测试'), /Live room turn protocol[\s\S]*让 Claude 测试/);
assert.equal(
  stripLeadingMentionForTarget({
    content: '$claude 请复核这个根因判断',
    targetDisplayName: 'claude',
  }),
  '请复核这个根因判断'
);
