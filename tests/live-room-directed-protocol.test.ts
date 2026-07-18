import assert from 'node:assert/strict';
import {
  buildLiveRoomContinuationMessage,
  buildLiveRoomControlManual,
} from '../src/lib/live-room-protocol';

const manual = buildLiveRoomControlManual({
  replyableMemberLabels: ['claude', 'antigravity'],
  directedTargetAlias: 'claude',
  directedTargetDisplayName: 'claude',
});

assert.match(manual, /Do not use spawn_agent, send_message/);
assert.match(manual, /reply should start with \$claude/);
assert.match(buildLiveRoomContinuationMessage(manual, '让 Claude 测试'), /\$member protocol[\s\S]*让 Claude 测试/);
