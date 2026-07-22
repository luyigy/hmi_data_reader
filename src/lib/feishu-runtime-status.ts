import fs from 'node:fs';
import path from 'node:path';

export type FeishuRuntimeStatus = {
  status: 'idle' | 'disabled' | 'starting' | 'running' | 'error' | 'stopped';
  mode: string;
  host: 'standalone' | 'nextjs';
  pid: number | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  lastError: string | null;
  updatedAt: string;
  metrics?: FeishuRuntimeMetrics | null;
};

export type FeishuRuntimeMetrics = {
  threads: number;
  openFileDescriptors: number;
  sqliteFileDescriptors: number;
  rssMb: number;
  health: 'healthy' | 'warning' | 'critical';
};

const STATUS_DIR = path.join(process.cwd(), '.runtime');
const STATUS_FILE = path.join(STATUS_DIR, 'feishu-long-connection.json');

function getNowIsoString() {
  return new Date().toISOString();
}

function isProcessAlive(pid: number | null) {
  if (!pid || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' &&
      error &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : '';
    return code === 'EPERM';
  }
}

export function classifyFeishuRuntimeMetrics(threads: number, sqliteFileDescriptors: number) {
  if (threads >= 250 || sqliteFileDescriptors >= 100) return 'critical' as const;
  if (threads >= 100 || sqliteFileDescriptors >= 25) return 'warning' as const;
  return 'healthy' as const;
}

function readProcessMetrics(pid: number): FeishuRuntimeMetrics | null {
  try {
    const procDir = `/proc/${pid}`;
    const status = fs.readFileSync(path.join(procDir, 'status'), 'utf8');
    const threads = Number(/^Threads:\s+(\d+)/m.exec(status)?.[1]);
    const rssKb = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]);
    const descriptors = fs.readdirSync(path.join(procDir, 'fd'));
    const sqliteFileDescriptors = descriptors.reduce((count, descriptor) => {
      try {
        const target = fs.readlinkSync(path.join(procDir, 'fd', descriptor));
        return count + (/\.(?:db|sqlite)(?:-(?:wal|shm))?(?: \(deleted\))?$/.test(target) ? 1 : 0);
      } catch {
        return count;
      }
    }, 0);
    if (!Number.isFinite(threads) || !Number.isFinite(rssKb)) return null;
    return {
      threads,
      openFileDescriptors: descriptors.length,
      sqliteFileDescriptors,
      rssMb: Math.round(rssKb / 1024),
      health: classifyFeishuRuntimeMetrics(threads, sqliteFileDescriptors),
    };
  } catch {
    return null;
  }
}

export function createFeishuRuntimeStatus(
  overrides: Partial<FeishuRuntimeStatus> = {}
): FeishuRuntimeStatus {
  return {
    status: 'idle',
    mode: process.env.FEISHU_CONNECTION_MODE?.trim() || 'long_connection',
    host: 'standalone',
    pid: process.pid,
    startedAt: null,
    lastHeartbeatAt: null,
    lastError: null,
    updatedAt: getNowIsoString(),
    ...overrides,
  };
}

export function readFeishuRuntimeStatus(): FeishuRuntimeStatus | null {
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as FeishuRuntimeStatus;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    if (parsed.status === 'running' && !isProcessAlive(parsed.pid)) {
      return createFeishuRuntimeStatus({
        ...parsed,
        status: 'stopped',
        lastError: parsed.lastError || 'Standalone runtime process is not running.',
        updatedAt: getNowIsoString(),
      });
    }
    return {
      ...parsed,
      metrics: parsed.pid ? readProcessMetrics(parsed.pid) : null,
    };
  } catch {
    return null;
  }
}

export function writeFeishuRuntimeStatus(status: FeishuRuntimeStatus) {
  fs.mkdirSync(STATUS_DIR, { recursive: true });
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2) + '\n', 'utf8');
}

export function updateFeishuRuntimeStatus(
  overrides: Partial<FeishuRuntimeStatus>
): FeishuRuntimeStatus {
  const nextStatus = createFeishuRuntimeStatus({
    ...readFeishuRuntimeStatus(),
    ...overrides,
    updatedAt: getNowIsoString(),
  });
  writeFeishuRuntimeStatus(nextStatus);
  return nextStatus;
}
