import assert from 'node:assert/strict';
import {
  decideWorkflowRoomRotation,
  formatWorkflowRotationNotice,
  parseWorkflowRotationThresholds,
  suggestHandoverPathFromPrompt,
  type WorkflowRoomWatermark,
} from '../src/lib/workflow-session-rotation';

// Workflow Handovers can live in a branch-space subdirectory (docs/dev/) or
// directly under docs/; both must be suggested so the dispatcher reuses the
// committed Handover instead of minting an emergency Session-rotation checkpoint.
assert.equal(
  suggestHandoverPathFromPrompt('读取 `docs/dev/229_HANDOVER_20260830_S04黏度速度与模温保存导出对照.md`、docs/dev/223_PLAN_x.md 和合同，只执行 S05。'),
  'docs/dev/229_HANDOVER_20260830_S04黏度速度与模温保存导出对照.md',
);
assert.equal(
  suggestHandoverPathFromPrompt('读取 docs/001_HANDOVER_20260731_fixture.md 后继续。'),
  'docs/001_HANDOVER_20260731_fixture.md',
);
assert.equal(
  suggestHandoverPathFromPrompt('读取 docs/dev/001_HANDOVER_20260731_fixture.md 后继续。'),
  'docs/dev/001_HANDOVER_20260731_fixture.md',
);
assert.equal(suggestHandoverPathFromPrompt('读取 docs/dev/223_PLAN_20260830_x.md 和 docs/dev/004_TODO_x.md。'), null);
assert.equal(suggestHandoverPathFromPrompt('没有提到任何 Handover。'), null);

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
