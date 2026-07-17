import assert from 'node:assert/strict';
import { executeAntigravityTask } from '../src/lib/real-agents/antigravity-agent';

const run = async () => {
  const safe = await executeAntigravityTask({ id: '1', name: 'smoke' }, { sandboxMode: 'workspace-write' });
  assert.equal(safe.success, true);
  assert.match(safe.output || '', /-p Task: smoke[\s\S]*--sandbox/);

  const full = await executeAntigravityTask({ id: '2', name: 'smoke' }, { sandboxMode: 'danger-full-access' });
  assert.equal(full.success, true);
  assert.match(full.output || '', /-p Task: smoke[\s\S]*--dangerously-skip-permissions/);
};

void run();
