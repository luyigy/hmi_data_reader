import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { historyStateRoot } from './guard';
export async function cleanupReadiness(): Promise<{ enabled: boolean; reason?: string }> {
  const root = historyStateRoot();
  try {
    const marker = JSON.parse(await readFile(path.join(root, 'enabled.json'), 'utf8'));
    if (marker.version === 1 && marker.reloadedAt && Array.isArray(marker.services) && marker.services.length === 5) return { enabled: true };
  } catch { /* No valid activation marker; surface the deployment state below. */ }
  let reason = '清理尚未启用：需在任务空闲时重载执行服务；历史查询和预览可用';
  try {
    const status = JSON.parse(await readFile(path.join(root, 'activation.json'), 'utf8'));
    if (status.state === 'failed') reason = '清理启用失败：执行服务尚未完成更新，请检查启用日志并重试。';
    else if (typeof status.updatedAt !== 'number' || Date.now() - status.updatedAt > 30000) reason = '清理启用任务未更新状态，可能已退出；请检查启用服务。';
    else if (status.state === 'waiting') {
      const counts = status.counts;
      if (counts && [counts.runs, counts.jobs, counts.deliveries].every(value => Number.isInteger(value) && value >= 0)) {
        reason = `等待任务空闲后自动启用清理：${counts.runs} 个未结束任务、${counts.jobs} 个执行中的定时任务、${counts.deliveries} 个执行中的消息派发。无需重复勾选。`;
      }
    } else if (status.state === 'reloading') reason = '正在更新执行服务并检查健康状态，完成后自动启用清理。';
  } catch { /* Keep cleanup disabled when status is missing or unreadable. */ }
  return { enabled: false, reason };
}
