import assert from 'node:assert/strict';
import {
  getWatermarkPolicyLabel,
  getWatermarkTooltip,
  getWatermarkUsageLabel,
} from '../src/components/live-room/live-room-workspace-models';
import type { LiveRoomMember } from '../src/types';

const member = (contextWatermark: NonNullable<LiveRoomMember['contextWatermark']>) =>
  ({ contextWatermark } as LiveRoomMember);
const base = {
  policyStatus: 'normal' as const,
  policyLabel: 'within policy',
  dominantReason: 'provider' as const,
  dominantLabel: 'provider',
  recommendedAction: 'No action needed.',
  messageCount: 100,
  eventCount: 500,
  transcriptChars: 5_000,
  remainingMessages: 0,
  remainingEvents: 0,
  remainingTranscriptChars: 0,
};

const provider = member({
  ...base,
  source: 'provider',
  usagePercentage: 42,
  usageStatus: 'light',
});
assert.equal(getWatermarkUsageLabel(provider), 'Used 42%');
assert.match(getWatermarkTooltip(provider), /usage: 42%/);

const unknown = member({
  ...base,
  source: 'unknown',
  usagePercentage: null,
  usageStatus: 'unknown',
  policyStatus: 'warning',
  policyLabel: 'agent signal warning',
  dominantReason: 'events',
  dominantLabel: 'agent signal · events',
});
assert.equal(getWatermarkUsageLabel(unknown), 'No provider context telemetry');
assert.equal(getWatermarkPolicyLabel(unknown), 'Agent signal warning');
assert.doesNotMatch(getWatermarkTooltip(unknown), /usage:|%/);

const notApplicable = member({
  ...base,
  source: 'not_applicable',
  usagePercentage: null,
  usageStatus: 'not_applicable',
  policyLabel: 'not applicable',
  dominantReason: 'messages',
  dominantLabel: 'fresh conversation per turn',
});
assert.equal(getWatermarkUsageLabel(notApplicable), 'Fresh conversation each turn');
assert.equal(getWatermarkPolicyLabel(notApplicable), 'Not applicable');
assert.doesNotMatch(getWatermarkTooltip(notApplicable), /new-session|reset/i);

console.log('context watermark display tests passed');
