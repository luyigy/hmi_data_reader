import { execFile, spawn } from 'node:child_process';
import { sendFeishuTextMessage } from '../feishu-api';
import { LONG_FILE_CONTRACT_PATH, parseLongFileRules } from '../long-file-guard';
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

const gitBlobs = (cwd: string, signal: AbortSignal, blobs: string[]) => new Promise<Buffer[]>((resolve, reject) => {
  if (!blobs.length) return resolve([]);
  const child = spawn('git', ['-C', cwd, 'cat-file', '--batch'], { signal, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.on('error', reject);
  child.on('close', (code) => {
    if (code !== 0) return reject(new Error(Buffer.concat(stderr).toString().trim() || `git cat-file exited with ${code}`));
    const output = Buffer.concat(stdout);
    const contents: Buffer[] = [];
    let offset = 0;
    for (const blob of blobs) {
      const newline = output.indexOf(10, offset);
      const header = newline < 0 ? '' : output.subarray(offset, newline).toString();
      const match = header.match(/^([0-9a-f]+) blob (\d+)$/);
      if (!match || match[1] !== blob) return reject(new Error(`invalid git cat-file response for ${blob}`));
      const size = Number(match[2]);
      offset = newline + 1;
      contents.push(output.subarray(offset, offset + size));
      offset += size + 1;
    }
    resolve(contents);
  });
  child.stdin.end(`${blobs.join('\n')}\n`);
});

const lineCount = (content: Buffer) => {
  if (!content.length) return 0;
  let lines = content.at(-1) === 10 ? 0 : 1;
  for (let index = 0; index < content.length; index += 1) if (content[index] === 10) lines += 1;
  return lines;
};

export async function detectLongFiles(
  cwd: string,
  ref: string,
  signal: AbortSignal,
) {
  const head = (await git(cwd, signal, 'rev-parse', '--verify', `${ref}^{commit}`)).toString().trim();
  const rules = parseLongFileRules((await git(cwd, signal, 'show', `${head}:${LONG_FILE_CONTRACT_PATH}`)).toString());
  const tree = (await git(cwd, signal, 'ls-tree', '-r', '-z', '--full-tree', head)).toString();
  const offenders: Offender[] = [];
  const candidates: Array<{ blob: string; filePath: string }> = [];

  for (const entry of tree.split('\0')) {
    if (!entry) continue;
    const match = entry.match(/^\d+ blob ([0-9a-f]+)\t([\s\S]*)$/);
    if (!match) continue;
    const [, blob, filePath] = match;
    if (filePath.split('/').some((part) => rules.ignored.has(part))) continue;
    const extension = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')).toLowerCase() : '';
    if (!rules.extensions.has(extension)) continue;
    candidates.push({ blob, filePath });
  }
  const contents = await gitBlobs(cwd, signal, candidates.map(({ blob }) => blob));
  candidates.forEach(({ blob, filePath }, index) => {
    const lines = lineCount(contents[index]);
    if (lines >= rules.blocking) offenders.push({ path: filePath, blob, head, lines });
  });
  return { head, threshold: rules.blocking, offenders };
}

const cursorFiles = (cursor: unknown) => {
  if (!cursor || typeof cursor !== 'object' || !('files' in cursor)) return {};
  const files = (cursor as { files?: unknown }).files;
  return files && typeof files === 'object' && !Array.isArray(files)
    ? files as Cursor['files']
    : {};
};

export const longFileDetectorHandler: JobHandler = async ({ project, mode, cursor, signal }) => {
  const { head, threshold, offenders } = await detectLongFiles(project.path, project.ref, signal);
  const previous = cursorFiles(cursor);
  const changed = offenders.filter((item) => {
    const prior = previous[item.path];
    return !prior || item.lines > Number(prior.lines || 0) || item.blob !== prior.blob;
  });
  const currentPaths = new Set(offenders.map((item) => item.path));
  const cleared = Object.keys(previous).filter((filePath) => !currentPaths.has(filePath));

  if (mode === 'active' && (changed.length || cleared.length)) {
    await sendFeishuTextMessage({
      receiveId: project.feishu.chat_id,
      text: [
        `[long-file-checker] ${offenders.length ? '⚠️ 长文件预警' : '✅ 已无超阈值文件'}（${project.id} @ ${head}，阈值 ${threshold} 行）`,
        `本次变化 ${changed.length + cleared.length} 个（超限变化 ${changed.length}，恢复 ${cleared.length}）；当前超限业务源码总数 ${offenders.length} 个。`,
        ...(changed.length ? [
          '超限变化：',
          ...changed.sort((left, right) => right.lines - left.lines).map((item) => `  • \`${item.path}\` — ${item.lines} 行`),
        ] : []),
        ...(cleared.length ? [
          '已恢复：',
          ...cleared.sort().map((filePath) => `  • \`${filePath}\``),
        ] : []),
      ].join('\n'),
    });
  }

  return {
    summary: `offenders=${offenders.length} changed=${changed.length} cleared=${cleared.length}`,
    cursor: {
      files: Object.fromEntries(offenders.map(({ path: filePath, ...item }) => [filePath, item])),
    },
  };
};
