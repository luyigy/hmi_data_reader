import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm, lstat, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { historyInventory } from '../src/lib/session-history/inventory';
import { previewCleanup, executeCleanup, deleteNativeHistory, readCleanup, cleanupReceipt } from '../src/lib/session-history/cleanup';
import { assertHistoryAvailable } from '../src/lib/session-history/guard';
import { HistoryReference, RETENTION_MS } from '../src/lib/session-history/types';

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'ap-history-cleanup-'));
  const state = path.join(root, 'audit'); process.env.AP_SESSION_HISTORY_STATE_ROOT = state;
  const source = { harness: 'pi-agent' as const, home: path.join(root, 'pi'), label: 'fixture' };
  const old = Date.now() - RETENTION_MS - 600000;
  const references: HistoryReference[] = [];
  const files: string[] = [];
  for (let index = 0; index < 3; index++) {
    const directory = path.join(source.home, `session-${index}`); await mkdir(directory, { recursive: true });
    const file = path.join(directory, 'native.jsonl'); files.push(file);
    await writeFile(file, JSON.stringify({ type: 'session', id: `native-${index}`, timestamp: new Date(old).toISOString() }) + '\n'); await utimes(file, old / 1000, old / 1000);
    references.push({ nativeId: directory, harness: 'pi-agent', participantId: `p-${index}`, taskId: `t-${index}`, taskName: 'test', lastActivity: old, protected: false, reasons: [] });
  }
  try {
    const readInventory = () => historyInventory({ sources: [source], references });
    const initial = await readInventory();
    const preview = await previewCleanup(initial.records.map(record => record.key), 'admin', readInventory);
    assert.equal(preview.items.length, 3);
    await assert.rejects(executeCleanup(preview.id, 'admin'), /尚未启用/);
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, 'enabled.json'), JSON.stringify({ version: 1, reloadedAt: Date.now(), services: ['1','2','3','4','5'] }));
    await assert.rejects(readCleanup(preview.id, 'other'), /本人/);
    const revoked: string[] = []; let deletes = 0;
    const services = { readInventory, recheckReferences: async () => {}, assertIdle: async () => {}, assertNoActiveHarness: async () => {},
      revokeHistoryReferences: async (_harness: string, id: string) => { revoked.push(id); },
      deleteNativeHistory: async (record: Parameters<typeof deleteNativeHistory>[0]) => {
        deletes++; assert.ok(revoked.includes(record.nativeId), 'revocation precedes native deletion');
        await assert.rejects(assertHistoryAvailable(record.harness, record.nativeId), /清理/, 'tombstone precedes deletion');
        if (record.nativeId.endsWith('session-1')) throw new Error('native failure');
        await deleteNativeHistory(record);
      } };
    await appendFile(files[2], '{}\n'); // One fixed candidate changed after preview.
    const result = await executeCleanup(preview.id, 'admin', services);
    assert.equal(result.state, 'needs_review'); assert.equal(result.items.filter(item => item.status === 'deleted').length, 1);
    assert.equal(result.items.filter(item => item.status === 'failed').length, 2);
    assert.equal(deletes, 2); assert.equal(revoked.length, 2);
    await assert.rejects(lstat(files[0]), { code: 'ENOENT' }); assert.ok(await lstat(files[1])); assert.ok(await lstat(files[2]));
    assert.equal(cleanupReceipt(result).deletedBytes, initial.records.find(record => record.nativeId.endsWith('session-0'))!.bytes);
    const repeated = await executeCleanup(preview.id, 'admin', services);
    assert.deepEqual(repeated, result); assert.equal(deletes, 2, 'retry does not replay native actions');
    const later = await readInventory(); assert.equal(later.inventory.rows.find(row => row.nativeId.endsWith('session-1'))?.state, 'protected', 'failed native action remains blocked pending review');
    const denied = await previewCleanup(['a'.repeat(64)], 'admin', readInventory); assert.equal(denied.items.length, 0); assert.equal(denied.excluded.length, 1);
    const expired = await previewCleanup([initial.records[2].key], 'admin', readInventory);
    expired.expiresAt = Date.now() - 1; await writeFile(path.join(state, 'operations', expired.id + '.json'), JSON.stringify(expired));
    await assert.rejects(executeCleanup(expired.id, 'admin', services), /过期/);
    console.log('Session cleanup: fixed preview, readiness, actor binding, retention recheck, revocation-before-delete, partial failure, replay and expiry passed.');
  } finally { await rm(root, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
