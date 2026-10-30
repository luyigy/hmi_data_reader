import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanupReadiness } from '../src/lib/session-history/readiness';
async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'ap-history-readiness-'));
  process.env.AP_SESSION_HISTORY_STATE_ROOT = root;
  try {
    assert.equal((await cleanupReadiness()).enabled, false);
    const status = async (state: string, updatedAt = Date.now()) => writeFile(path.join(root, 'activation.json'), JSON.stringify({ state, updatedAt, counts: { runs: 1, jobs: 0, deliveries: 1 } }));
    await status('waiting'); assert.match((await cleanupReadiness()).reason!, /1 个未结束任务/);
    await status('waiting', Date.now() - 60000); assert.match((await cleanupReadiness()).reason!, /可能已退出/);
    await status('failed'); assert.match((await cleanupReadiness()).reason!, /启用失败/);
    await status('reloading'); assert.match((await cleanupReadiness()).reason!, /正在更新/);
    await writeFile(path.join(root, 'activation.json'), 'broken'); assert.equal((await cleanupReadiness()).enabled, false);
    await writeFile(path.join(root, 'enabled.json'), JSON.stringify({ version: 1, reloadedAt: Date.now(), services: ['1','2','3','4','5'] }));
    assert.equal((await cleanupReadiness()).enabled, true, 'completed reload supersedes stale activation status');
    console.log('Readiness: waiting, failed, stale, reload and successful activation states passed.');
  } finally { await rm(root, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
