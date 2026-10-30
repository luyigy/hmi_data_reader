import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { historyStateRoot } from './guard';
export async function cleanupReadiness(): Promise<{ enabled: boolean; reason?: string }> {
  try {
    const marker = JSON.parse(await readFile(path.join(historyStateRoot(), 'enabled.json'), 'utf8'));
    return marker.version === 1 && marker.reloadedAt && Array.isArray(marker.services) && marker.services.length === 5
      ? { enabled: true } : { enabled: false, reason: '等待执行服务加载会话清理保护后启用' };
  } catch { return { enabled: false, reason: '清理尚未启用：需在任务空闲时重载执行服务；历史查询和预览可用' }; }
}
