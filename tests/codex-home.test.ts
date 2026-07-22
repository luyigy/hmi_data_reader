import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareCodexHome } from '../src/lib/real-agents/codex-home';

const root = mkdtempSync(path.join(tmpdir(), 'codex-home-test-'));
try {
  const shared = path.join(root, 'shared');
  const room = path.join(root, 'rooms', 'room-1');
  mkdirSync(path.join(shared, 'skills'), { recursive: true });
  writeFileSync(path.join(shared, 'auth.json'), '{}');

  prepareCodexHome(room, shared);

  assert.equal(realpathSync(path.join(room, 'auth.json')), path.join(shared, 'auth.json'));
  assert.equal(realpathSync(path.join(room, 'skills')), path.join(shared, 'skills'));
  assert.equal(existsSync(path.join(room, 'sessions')), false);
} finally {
  rmSync(root, { recursive: true, force: true });
}
