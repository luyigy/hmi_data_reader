import assert from 'node:assert/strict';
import { normalizeCodexMemberSettings } from '../src/lib/live-room-codex-settings';

const settings = normalizeCodexMemberSettings({
  model: 'gpt-5.6',
  reasoningEffort: 'HIGH',
});
assert.deepEqual(settings, { model: 'gpt-5.6', reasoningEffort: 'high' });
assert.throws(() => normalizeCodexMemberSettings({ model: 'gpt-5.6; rm' }));
