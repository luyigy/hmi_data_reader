import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, symlink, rm, lstat, appendFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { scanSource, ScanBudget, defaultSources } from '../src/lib/session-history/scan';
import { classifyHistory, historyInventory } from '../src/lib/session-history/inventory';
import { deleteNativeHistory } from '../src/lib/session-history/cleanup';
import { blockHistorySession, assertHistoryAvailable, withHistoryLock, withHistoryProtection } from '../src/lib/session-history/guard';
import { RETENTION_MS, HistoryReference } from '../src/lib/session-history/types';
import { resolveRouteAuth } from '../src/lib/auth-routes';
import { getContinuationSession } from '../src/lib/acpx/session-tracking';
import { getHarnessAdapter } from '../src/lib/harness';
import { codexHarnessAdapter } from '../src/lib/harness/adapters/codex';

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'ap-history-test-'));
  process.env.AP_SESSION_HISTORY_STATE_ROOT = path.join(root, 'audit');
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, 'configured-codex');
  assert.ok(defaultSources().some(source => source.harness === 'codex' && source.home === path.join(homedir(), '.codex')));
  assert.ok(defaultSources().some(source => source.home === process.env.CODEX_HOME));
  if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
  const now = Date.now(), old = now - RETENTION_MS - 100000;
  const id = '11111111-1111-4111-8111-111111111111';
  const source = { harness: 'codex' as const, home: path.join(root, 'codex'), label: 'fixture' };
  const dir = path.join(source.home, 'sessions/2026/01/01'); await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-test-${id}.jsonl`);
  await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/project' }, timestamp: new Date(old).toISOString() }) + '\n');
  await utimes(file, old / 1000, old / 1000);
  try {
    const records = await scanSource(source, new ScanBudget()); assert.equal(records.length, 1);
    const record = records[0]; assert.equal(record.project, '/project'); assert.equal(record.bytes, (await lstat(file)).size);
    const ref: HistoryReference = { nativeId: id, harness: 'codex', participantId: 'p1', taskId: 't1', taskName: 'Task', lastActivity: old, protected: false, reasons: [] };
    assert.equal(classifyHistory(record, [ref], now, false).state, 'eligible');
    assert.equal(classifyHistory(record, [ref], old + RETENTION_MS, false).state, 'retained', 'exact 30-day boundary protected');
    assert.equal(classifyHistory(record, [{ ...ref, lastActivity: now - 1000 }], now, false).state, 'retained');
    assert.equal(classifyHistory(record, [], now, false).state, 'protected', 'unassociated CLI history never assumed idle');
    assert.equal(classifyHistory(record, [ref], now, true).state, 'protected', 'same ID across homes not merged');
    assert.equal(classifyHistory(record, [ref, { ...ref, participantId: 'p2', reasons: ['仍绑定'], protected: true }], now, false).state, 'protected');
    assert.equal(classifyHistory({ ...record, lastActivity: now + 1 }, [ref], now, false).state, 'unknown');
    assert.equal(classifyHistory({ ...record, harness: 'kimi-code' }, [{ ...ref, harness: 'kimi-code' }], now, false).state, 'protected');
    await symlink(file, path.join(dir, `rollout-link-22222222-2222-4222-8222-222222222222.jsonl`));
    await assert.rejects(scanSource(source, new ScanBudget()), /符号链接/);
    await rm(path.join(dir, 'rollout-link-22222222-2222-4222-8222-222222222222.jsonl'));
    await assert.rejects(scanSource(source, new ScanBudget(1)), /上限/);
    const inventory = await historyInventory({ sources: [source], references: [ref], now });
    assert.equal(inventory.inventory.rows[0].state, 'eligible');
    assert.equal('files' in inventory.inventory.rows[0], false, 'file deletion manifest is server-owned');

    const pi = { harness: 'pi-agent' as const, home: path.join(root, 'pi'), label: 'fixture' };
    const piDir = path.join(pi.home, 'managed'); await mkdir(piDir, { recursive: true });
    for (let index = 0; index < 2; index++) {
      const age = index === 0 ? old : now - 1000;
      const filename = path.join(piDir, `${index}.jsonl`); await writeFile(filename, JSON.stringify({ type: 'session', id: `native${index}`, cwd: '/project', timestamp: new Date(age).toISOString() }) + '\n'); await utimes(filename, age / 1000, age / 1000);
    }
    let piRecord = (await scanSource(pi, new ScanBudget()))[0];
    assert.equal(piRecord.files.length, 2, JSON.stringify(piRecord)); assert.equal(classifyHistory(piRecord, [{ ...ref, harness: 'pi-agent', nativeId: piDir }], now, false).state, 'retained');
    await appendFile(path.join(piDir, '0.jsonl'), '{}\n');
    await assert.rejects(deleteNativeHistory(piRecord), /变化/);
    piRecord = (await scanSource(pi, new ScanBudget()))[0];
    await deleteNativeHistory(piRecord); await assert.rejects(lstat(piDir), { code: 'ENOENT' });

    let entered = false;
    await withHistoryLock('test', false, async () => {
      await withHistoryLock('test', false, async () => { entered = true; });
      await assert.rejects(withHistoryLock('test', true, async () => { throw new Error('should never acquire'); }), /正在使用/);
    });
    assert.equal(entered, true);
    await withHistoryLock('test', true, async () => { entered = false; }); assert.equal(entered, false);
    await blockHistorySession('codex', id, 'fixture');
    await assert.rejects(assertHistoryAvailable('codex', id), /清理/);
    let resumed = false;
    const adapter = withHistoryProtection({ ...codexHarnessAdapter, type: 'codex', execute: async () => ({ success: true, executionTime: 0 }), resume: async () => { resumed = true; return { success: true, executionTime: 0 }; } });
    await assert.rejects(adapter.resume!({ task: { id: 'x', name: 'x' }, context: { executionBackend: 'platform_local', workingDirectory: root, timeout: 1000 }, sessionId: id, continuationMessage: 'test' }), /清理/);
    assert.equal(resumed, false);
    const piNative: typeof import('../src/lib/real-agents/pi-agent') = require('../src/lib/real-agents/pi-agent');
    const originalPi = piNative.executePiAgentTask;
    const sessionKey = 'history-fixture-' + path.basename(root);
    const deletedDir = piNative.resolvePiAgentSessionDir(sessionKey);
    await blockHistorySession('pi-agent', deletedDir, 'fixture');
    let newDirectory: string | undefined;
    try {
      const replacement: typeof piNative.executePiAgentTask = async (_task, options = {}) => { newDirectory = options.sessionDir; return { success: true, executionTime: 0, sessionDir: options.sessionDir }; };
      Object.assign(piNative, { executePiAgentTask: replacement });
      await getHarnessAdapter('pi-agent')!.execute({ task: { id: 'fresh', name: 'fresh' }, context: { executionBackend: 'platform_local', workingDirectory: root, timeout: 1000, sessionKey } });
      assert.ok(newDirectory?.startsWith(deletedDir + '-fresh-'), 'new Pi invocation gets a new identity after cleanup');
    } finally { Object.assign(piNative, { executePiAgentTask: originalPi }); }

    assert.equal(getContinuationSession({ harnessType: 'codex', controlMetadata: JSON.stringify({ lastSessionId: id, codexThreadId: id, historyDeletedAt: new Date().toISOString() }) }).sessionId, null);
    for (const [surface, pathname, method] of [['page', '/admin/session-history', 'GET'], ['api', '/api/admin/session-history', 'GET'], ['api', '/api/admin/session-history', 'POST']] as const) assert.deepEqual(resolveRouteAuth({ surface, pathname, method }), { access: 'admin' });
    console.log('Session history: retention, references, symlinks, budgets, Pi cleanup, shared/exclusive leases, tombstones and admin routes passed.');
  } finally { await rm(root, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
