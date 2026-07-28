import { execFile } from 'node:child_process';
import { sendFeishuTextMessage } from '../feishu-api';
import type { JobHandler } from './handlers';

type Offender = { path: string; blob: string; head: string; lines: number };
type Cursor = { files: Record<string, Omit<Offender, 'path'>> };

const git = (cwd: string, signal: AbortSignal, ...args: string[]) => new Promise<Buffer>((resolve, reject) => {
  execFile('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], {
    encoding: 'buffer',
    maxBuffer: 100 * 1024 * 1024,
    signal,
  }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr.toString().trim() || error.message));
    else resolve(stdout);
  });
});

const lineCount = (content: Buffer) => {
  if (!content.length) return 0;
  let lines = content.at(-1) === 10 ? 0 : 1;
  for (let index = 0; index < content.length; index += 1) if (content[index] === 10) lines += 1;
  return lines;
};

export const parseLongFileDetectorConfig = (config: Record<string, unknown>) => {
  const threshold = config.threshold_lines;
  const extensions = config.extensions;
  const excludes = config.exclude_paths ?? [];
  if (!Number.isInteger(threshold) || Number(threshold) < 1) throw new Error('threshold_lines must be a positive integer');
  if (!Array.isArray(extensions) || !extensions.length || extensions.some((item) => typeof item !== 'string' || !item.startsWith('.'))) {
    throw new Error('extensions must be a non-empty array of file extensions');
  }
  if (!Array.isArray(excludes) || excludes.some((item) => typeof item !== 'string')) {
    throw new Error('exclude_paths must be an array of strings');
  }
  return {
    threshold: Number(threshold),
    extensions: new Set(extensions.map((item) => item.toLowerCase())),
    excludes: excludes as string[],
  };
};

export async function detectLongFiles(
  cwd: string,
  ref: string,
  config: Record<string, unknown>,
  signal: AbortSignal,
) {
  const { threshold, extensions, excludes } = parseLongFileDetectorConfig(config);
  const head = (await git(cwd, signal, 'rev-parse', '--verify', `${ref}^{commit}`)).toString().trim();
  const tree = (await git(cwd, signal, 'ls-tree', '-r', '-z', '--full-tree', head)).toString();
  const offenders: Offender[] = [];

  for (const entry of tree.split('\0')) {
    if (!entry) continue;
    const match = entry.match(/^\d+ blob ([0-9a-f]+)\t([\s\S]*)$/);
    if (!match) continue;
    const [, blob, filePath] = match;
    if (excludes.some((prefix) => filePath.startsWith(prefix))) continue;
    const extension = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')).toLowerCase() : '';
    if (!extensions.has(extension)) continue;
    const lines = lineCount(await git(cwd, signal, 'cat-file', 'blob', blob));
    if (lines >= threshold) offenders.push({ path: filePath, blob, head, lines });
  }
  return offenders;
}

const cursorFiles = (cursor: unknown) => {
  if (!cursor || typeof cursor !== 'object' || !('files' in cursor)) return {};
  const files = (cursor as { files?: unknown }).files;
  return files && typeof files === 'object' && !Array.isArray(files)
    ? files as Cursor['files']
    : {};
};

export const longFileDetectorHandler: JobHandler = async ({ project, job, mode, cursor, signal }) => {
  const offenders = await detectLongFiles(project.path, project.ref, job.config, signal);
  const previous = cursorFiles(cursor);
  const changed = offenders.filter((item) => {
    const prior = previous[item.path];
    return !prior || item.lines > Number(prior.lines || 0) || item.blob !== prior.blob;
  });
  const currentPaths = new Set(offenders.map((item) => item.path));
  const cleared = Object.keys(previous).filter((filePath) => !currentPaths.has(filePath));

  if (mode === 'active' && changed.length) {
    const threshold = Number(job.config.threshold_lines);
    await sendFeishuTextMessage({
      receiveId: project.feishu.chat_id,
      text: [
        `[long-file-checker] ⚠️ 长文件预警（${project.id} @ ${project.ref}，阈值 ${threshold} 行）`,
        `命中 ${changed.length} 个文件：`,
        ...changed.sort((left, right) => right.lines - left.lines).map((item) => `  • \`${item.path}\` — ${item.lines} 行`),
      ].join('\n'),
    });
  }
  if (mode === 'active' && cleared.length) {
    await sendFeishuTextMessage({
      receiveId: project.feishu.chat_id,
      text: `[long-file-checker] ✅ 已不再超阈值（${project.id}）：\n${cleared.sort().map((filePath) => `  • \`${filePath}\``).join('\n')}`,
    });
  }

  return {
    summary: `offenders=${offenders.length} changed=${changed.length} cleared=${cleared.length}`,
    cursor: {
      files: Object.fromEntries(offenders.map(({ path: filePath, ...item }) => [filePath, item])),
    },
  };
};
