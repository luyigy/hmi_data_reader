import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import { isFeishuAdmin } from '@/lib/feishu-access-approval';
import { importMarkdownAsFeishuDocument } from '@/lib/feishu-document-import';
import { getBoundLiveRoom, type FeishuConversationContext } from '@/lib/feishu-live-room';
import { prisma } from '@/lib/prisma';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const normalizeRepositoryMarkdownPath = (value: string) => {
  const normalized = path.posix.normalize(value.trim().replaceAll('\\', '/'));
  if (!normalized || normalized === '.' || path.posix.isAbsolute(normalized)
    || normalized === '..' || normalized.startsWith('../')
    || path.posix.extname(normalized).toLowerCase() !== '.md') return null;
  return normalized.replace(/^\.\//, '');
};

export async function handleFeishuDocumentCommand(
  command: ParsedFeishuCommand,
  context?: FeishuConversationContext,
) {
  const documentPath = normalizeRepositoryMarkdownPath(command.args.join(' '));
  if (!documentPath) return '用法：/ap doc <仓库内已提交的 Markdown 路径>';
  const room = await getBoundLiveRoom(context);
  const workingDirectory = room?.sourceTask?.workingDirectory;
  if (!workingDirectory) return '当前飞书会话未绑定带工作目录的 Live Room。';
  if (!isFeishuAdmin(context?.senderOpenId)) {
    const access = context?.senderOpenId
      ? await prisma.feishuUserAccess.findUnique({
          where: { openId: context.senderOpenId },
          select: { status: true, workspaceRoot: true },
        })
      : null;
    const relative = access?.workspaceRoot
      ? path.relative(path.resolve(access.workspaceRoot), path.resolve(workingDirectory))
      : '..';
    if (access?.status !== 'approved'
      || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return '当前用户无权导出该工作区文档。';
    }
  }

  try {
    const [{ stdout: content }, { stdout: head }] = await Promise.all([
      execFileAsync('git', ['-c', 'core.quotepath=false', 'show', `HEAD:${documentPath}`], {
        cwd: workingDirectory,
        encoding: 'utf8',
      }),
      execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: workingDirectory,
        encoding: 'utf8',
      }),
    ]);
    const name = path.posix.basename(documentPath, '.md');
    const url = await importMarkdownAsFeishuDocument({
      content,
      name,
      signal: AbortSignal.timeout(120_000),
    });
    return [
      `✅ 已转为飞书文档：[${name}](${url})`,
      `来源：${documentPath}`,
      `Git HEAD：${head.trim()}`,
    ].join('\n');
  } catch (error) {
    return `❌ 文档转换失败：${error instanceof Error ? error.message : String(error)}`;
  }
}
