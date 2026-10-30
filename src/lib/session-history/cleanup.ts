import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { historyInventory, invalidateHistoryInventory, classifyHistory } from './inventory';
import { cleanupReadiness } from './readiness';
import { assertNoActiveHarness, revokeHistoryReferences, historyReferences } from './references';
import { blockHistorySession, historyStateRoot, withHistoryLock } from './guard';
import { measureRecord, safeStat } from './scan';
import { HistoryRecord, HistoryRow } from './types';
const exec = promisify(execFile);

type CleanupItem = { record: HistoryRecord; row: HistoryRow; status: 'pending' | 'deleting' | 'deleted' | 'failed'; error?: string };
export type CleanupOperation = {
  id: string; actor: string; createdAt: number; expiresAt: number;
  state: 'preview' | 'executing' | 'completed' | 'needs_review';
  items: CleanupItem[]; excluded: Array<{ key: string; reasons: string[] }>;
};
function operationFile(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的清理操作 ID');
  return path.join(historyStateRoot(), 'operations', id + '.json');
}
async function save(operation: CleanupOperation) {
  const file = operationFile(operation.id); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID();
  await writeFile(temporary, JSON.stringify(operation), { mode: 0o600 }); await rename(temporary, file);
}
export async function readCleanup(id: string, actor: string) {
  const result = JSON.parse(await readFile(operationFile(id), 'utf8')) as CleanupOperation;
  if (result.actor !== actor) throw new Error('只能查看和确认本人发起的清理操作');
  return result;
}
export function cleanupReceipt(operation: CleanupOperation) {
  return { ...operation, items: operation.items.map(({ row, status, error }) => ({ row, status, error })),
    bytes: operation.items.reduce((sum, item) => sum + (item.row.bytes || 0), 0),
    deletedBytes: operation.items.filter(item => item.status === 'deleted').reduce((sum, item) => sum + (item.row.bytes || 0), 0) };
}
export async function previewCleanup(keys: string[], actor: string, readInventory = historyInventory): Promise<CleanupOperation> {
  if (!keys.length || keys.length > 100 || keys.some(key => !/^[a-f0-9]{64}$/.test(key))) throw new Error('请选择 1—100 条会话');
  const { inventory, records } = await readInventory();
  const operation: CleanupOperation = { id: randomUUID(), actor, createdAt: Date.now(), expiresAt: Date.now() + 10 * 60000, state: 'preview', items: [], excluded: [] };
  for (const key of Array.from(new Set(keys))) {
    const row = inventory.rows.find(row => row.key === key), record = records.find(record => record.key === key);
    if (row?.state === 'eligible' && record) operation.items.push({ row, record, status: 'pending' });
    else operation.excluded.push({ key, reasons: row?.reasons || ['会话不存在或不在允许扫描范围'] });
  }
  await save(operation); return operation;
}

// Direct CLI instances do not acquire platform leases. Refuse when any matching executable exists.
// Persistent native daemons also count: cleanup never tries to terminate them on the user's behalf.
async function assertNativeOffline(harness: string) {
  if (process.platform !== 'linux') throw new Error('当前系统尚未实现本机进程排他检查');
  const names = harness === 'codex' ? /^(codex|codex-linux.*)$/ : /^(pi|pi-agent)$/;
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const info = await lstat(`/proc/${pid}`);
      if (info.uid !== process.getuid?.()) continue;
      const executable = path.basename(await readlink(`/proc/${pid}/exe`));
      const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
      if (names.test(executable) || argv.slice(0, 3).some(arg => names.test(path.basename(arg)))
        || (harness === 'pi-agent' && argv.slice(0, 3).some(arg => /pi-coding-agent.*(?:cli|index)\.(?:js|mjs)$/.test(arg)))) {
        throw new Error(`原生工具或后台进程 PID ${pid} 尚未退出，无法确认排他清理；退出后重试`);
      }
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code || '')) continue;
      throw error;
    }
  }
}
export async function deleteNativeHistory(record: HistoryRecord) {
  if (record.harness === 'codex') {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(record.nativeId)) throw new Error('Codex ID 格式无效');
    // The native command owns rollout/index/SQLite consistency; never delete only the JSONL.
    try {
      await exec(process.env.CODEX_CLI_PATH || 'codex', ['--no-daemon', 'delete', '--force', record.nativeId], {
        env: { ...process.env, CODEX_HOME: record.home }, cwd: record.home, timeout: 30000, maxBuffer: 1024 * 1024,
      });
    } catch { throw new Error('Codex 原生删除未成功；未绕过原生校验，需核对操作后再处理'); }
    for (const file of record.files) {
      try { await lstat(path.join(record.location, file.relative)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      throw new Error('Codex 返回后原生记录仍存在，未确认删除');
    }
    return;
  }
  if (record.harness !== 'pi-agent') throw new Error('此工具的永久清理尚未适配');
  const latest = await measureRecord(record, record.nativeId, record.location);
  if (latest.issues.length || latest.fingerprint !== record.fingerprint) throw new Error('Pi 文件发生变化，请重新预览');
  const holding = path.join(record.home, '.ap-delete-' + record.key);
  await safeStat(record.home, record.location);
  await rename(record.location, holding);
  const moved = await measureRecord(record, holding, holding);
  if (moved.issues.length || moved.fingerprint !== record.fingerprint) {
    // Do not overwrite a path recreated by an external process.
    try { await lstat(record.location); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') await rename(holding, record.location);
    }
    throw new Error('移动后身份校验失败，文件保留待核对');
  }
  for (const file of moved.files) await unlink(path.join(holding, file.relative));
  await rmdir(holding);
}
const cleanupServices = {
  readInventory: historyInventory,
  assertIdle: async (harness: string) => { await assertNoActiveHarness(harness); await assertNativeOffline(harness); },
  assertNoActiveHarness, revokeHistoryReferences, deleteNativeHistory,
  recheckReferences: async (record: HistoryRecord) => {
    const row = classifyHistory(record, await historyReferences({ harness: record.harness, nativeId: record.nativeId }), Date.now(), false);
    if (row.state !== 'eligible') throw new Error('会话新增绑定或活动，请重新预览');
  },
};
export async function executeCleanup(id: string, actor: string, services = cleanupServices) {
  const ready = await cleanupReadiness();
  if (!ready.enabled) throw new Error(ready.reason);
  return withHistoryLock('operation-' + id, true, async () => {
    const operation = await readCleanup(id, actor);
    if (operation.state !== 'preview') return operation; // Retry reads the durable receipt, never replays a partial deletion.
    if (Date.now() >= operation.expiresAt) throw new Error('预览已过期，请重新选择并预览');
    operation.state = 'executing'; await save(operation);
    for (const harness of Array.from(new Set(operation.items.map(item => item.record.harness)))) {
      const items = operation.items.filter(item => item.record.harness === harness);
      try {
        await withHistoryLock(harness, true, async () => {
          await services.assertIdle(harness);
          const { inventory, records } = await services.readInventory();
          for (const item of items) {
            try {
              const current = records.find(record => record.key === item.record.key);
              const row = inventory.rows.find(row => row.key === item.record.key);
              if (row?.state !== 'eligible' || !current || current.fingerprint !== item.record.fingerprint || row.lastActivity !== item.row.lastActivity) throw new Error('会话状态或文件已变化，请重新预览');
              // The harness lease remains exclusive throughout this batch. Recheck storage just before mutation.
              const latest = await measureRecord(current, current.nativeId, current.location,
                current.harness === 'codex' ? current.files.map(file => file.relative) : undefined);
              if (latest.issues.length || latest.fingerprint !== current.fingerprint) throw new Error('预览后文件发生变化');
              await services.assertNoActiveHarness(harness);
              await services.recheckReferences(latest);
              item.status = 'deleting'; await save(operation);
              await blockHistorySession(harness, current.nativeId, operation.id);
              await services.revokeHistoryReferences(harness, current.nativeId, operation.id);
              await services.deleteNativeHistory(current);
              item.status = 'deleted';
            } catch (error) { item.status = 'failed'; item.error = error instanceof Error ? error.message : '清理失败'; }
            await save(operation);
          }
        });
      } catch (error) {
        for (const item of items) if (item.status === 'pending') {
          item.status = 'failed'; item.error = error instanceof Error ? error.message : '清理失败';
        }
        await save(operation);
      }
    }
    invalidateHistoryInventory();
    operation.state = operation.items.some(item => item.status === 'failed') ? 'needs_review' : 'completed';
    await save(operation); return operation;
  });
}
