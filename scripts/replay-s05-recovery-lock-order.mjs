/** Replay the final regression against immutable pre-fix source in a disposable worktree. */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = 'dee66bc56a3dab8ddead23110ac5d356de714725';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 's05-red-replay-'));
const checkout = path.join(temporary, 'repo');
const issueSyncControl = process.argv.includes('--issue-sync-control');
const destination = path.resolve(root, process.argv.slice(2).find(arg => !arg.startsWith('--')) || (issueSyncControl ? 'output/reviews/s05-step2-issue-sync-baseline' : 'output/reviews/s05-step2-replay'));
const files = ['tests/task-graph-recovery-lock-order.test.ts', 'tests/fixtures/graph-lock-rendezvous.ts'];
let added = false;
try {
  execFileSync('git', ['worktree', 'add', '--detach', checkout, baseline], { cwd: root, stdio: 'pipe' }); added = true;
  fs.symlinkSync(fs.realpathSync(path.join(root, 'node_modules')), path.join(checkout, 'node_modules'));
  fs.mkdirSync(path.join(checkout, '.cache'), { recursive: true });
  fs.symlinkSync(path.join(root, '.cache/sandbox-postgres'), path.join(checkout, '.cache/sandbox-postgres'));
  for (const file of files) fs.copyFileSync(path.join(root, file), path.join(checkout, file));
  const runner = path.join(checkout, 'scripts/test-task-graph-postgres.mjs');
  fs.writeFileSync(runner, fs.readFileSync(runner, 'utf8').replace("const registeredSuites = [", "const registeredSuites = ['task-graph-recovery-lock-order', "));
  fs.mkdirSync(destination, { recursive: true });
  const command = ['scripts/sandbox-postgres-session.mjs', 'run', issueSyncControl ? 'task-graph-reclassification' : 'task-graph-recovery-lock-order'];
  const result = spawnSync(process.execPath, command, { cwd: checkout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const log = result.stdout + result.stderr;
  fs.writeFileSync(path.join(destination, 'replay.log'), log);
  const match = log.match(/证据目录 (output\/sandbox-postgres-runs\/[^\s]+)/);
  if (match) fs.cpSync(path.join(checkout, match[1]), path.join(destination, 'sandbox'), { recursive: true });
  fs.writeFileSync(path.join(destination, 'replay.json'), JSON.stringify({ baseline, command: [process.execPath, ...command],
    cwd: checkout, exit: result.status, testFiles: files.map(file => ({ file, sha256: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') })), sourceChanges: execFileSync('git', ['diff', '--name-only', '--', 'src'], { cwd: checkout, encoding: 'utf8' }) }, null, 2) + '\n');
  assert.equal(result.status, 1, 'Old source must fail the final behavior regression');
  if (issueSyncControl) {
    assert.match(log, /code: 'P2024'/); assert.match(log, /issue-sync\.ts:40/);
    console.log(`PASS baseline control: unchanged Issue sync fails with P2024 before reclassification; ${destination}`);
  } else {
  const failures = log.split('\n').filter(line => line.startsWith('FAIL '));
  assert.equal(failures.length, 7, failures.join('\n'));
  assert(failures.every(line => line.includes('recovery must commit without deadlock')), failures.join('\n'));
  assert.equal(log.split('\n').filter(line => line.startsWith('PASS ')).length, 11);
  assert(match, 'Sandbox evidence directory must be recorded');
  console.log(`PASS red replay: ${baseline}; child exit 1, seven target failures, eleven controls passed; ${destination}`);
  }
} finally {
  // Only remove this script's newly-created disposable checkout; never touch the user's worktree/history.
  if (added) execFileSync('git', ['worktree', 'remove', '--force', checkout], { cwd: root, stdio: 'pipe' });
  fs.rmSync(temporary, { recursive: true, force: true });
}
