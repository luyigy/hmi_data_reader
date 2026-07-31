import assert from 'node:assert/strict';
import {
  decideWorkflowRoomRotation,
  formatWorkflowRotationNotice,
  parseWorkflowRotationThresholds,
  type WorkflowRoomWatermark,
} from '../src/lib/workflow-session-rotation';

const sample = (
  memberId: string,
  usagePercentage: number | null,
  harnessType = 'codex',
): WorkflowRoomWatermark => ({
  memberId,
  memberName: memberId,
  harnessType,
  usagePercentage,
  source: usagePercentage === null ? 'unknown' : 'provider',
  label: usagePercentage === null ? 'context unknown' : 'provider',
});

const defaults = parseWorkflowRotationThresholds(undefined);
assert.deepEqual(defaults, {
  checkpointPreparationPercentage: 65,
  rotationPendingPercentage: 70,
  highPriorityPercentage: 85,
});
assert.deepEqual(parseWorkflowRotationThresholds({
  checkpoint_preparation_percentage: 60,
  rotation_pending_percentage: 75,
  high_priority_percentage: 90,
}), {
  checkpointPreparationPercentage: 60,
  rotationPendingPercentage: 75,
  highPriorityPercentage: 90,
});
assert.throws(() => parseWorkflowRotationThresholds({
  checkpoint_preparation_percentage: 80,
  rotation_pending_percentage: 70,
  high_priority_percentage: 90,
}), /checkpoint < rotation < high/);

assert.equal(
  decideWorkflowRoomRotation([sample('codex', 64), sample('kimi', 69)], defaults).action,
  'prepare_checkpoint',
);
assert.equal(decideWorkflowRoomRotation([sample('codex', 64)], defaults).action, 'reuse');
assert.equal(decideWorkflowRoomRotation([sample('codex', 65)], defaults).action, 'prepare_checkpoint');
assert.equal(decideWorkflowRoomRotation([sample('codex', 70)], defaults).action, 'rotation_pending');
assert.equal(decideWorkflowRoomRotation([sample('codex', 85)], defaults).highPriority, true);
const rotation = decideWorkflowRoomRotation([
  sample('codex', 71),
  sample('kimi', 86),
  sample('stale', null),
], defaults);
assert.equal(rotation.action, 'rotation_pending');
assert.equal(rotation.maximumUsagePercentage, 86);
assert.equal(rotation.dominant?.memberId, 'kimi');
assert.equal(rotation.highPriority, true);
assert.match(formatWorkflowRotationNotice(rotation, defaults), /高优先级/);
assert.match(formatWorkflowRotationNotice(rotation, defaults), /Session 不匹配/);

const unknown = decideWorkflowRoomRotation([sample('stale', null)], defaults);
assert.equal(unknown.action, 'warning_only');
assert.equal(unknown.maximumUsagePercentage, null);
assert.equal(unknown.highPriority, false);

const antigravity = decideWorkflowRoomRotation([
  sample('codex', 20),
  sample('antigravity', 72, 'antigravity'),
], defaults);
assert.equal(antigravity.action, 'rotation_pending');
assert.equal(antigravity.dominant?.harnessType, 'antigravity');

console.log('workflow session rotation checks passed');
