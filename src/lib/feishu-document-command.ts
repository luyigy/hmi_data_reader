import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import { isFeishuAdmin } from '@/lib/feishu-access-approval';
import { importMarkdownAsFeishuDocument } from '@/lib/feishu-document-import';
import { sendFeishuMarkdownFile } from '@/lib/feishu-api';
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

export async function assertFeishuDocumentAccess(context: FeishuConversationContext | undefined, workingDirectory: string) {
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
      throw new Error('当前用户无权导出该工作区文档。');
    }
  }
}

async function readRepositoryMarkdown(
  documentPath: string,
  context?: FeishuConversationContext,
  source?: { workingDirectory: string; ref: string; expectedHead?: string },
) {
  const room = source ? null : await getBoundLiveRoom(context);
  const workingDirectory = source?.workingDirectory || room?.sourceTask?.workingDirectory || room?.workingDirectory;
  if (!workingDirectory) throw new Error('当前飞书会话未绑定带工作目录的 Live Room。');
  await assertFeishuDocumentAccess(context, workingDirectory);
  const { stdout: headOutput } = await execFileAsync('git', ['rev-parse', source?.ref || 'HEAD'], {
    cwd: workingDirectory,
    encoding: 'utf8',
  });
  const head = headOutput.trim();
  if (source?.expectedHead && source.expectedHead !== head) {
    throw new Error('文档版本已更新，请重新打开文档列表后重试。');
  }
  const { stdout: content } = await execFileAsync(
    'git', ['-c', 'core.quotepath=false', 'show', `${head}:${documentPath}`],
    { cwd: workingDirectory, encoding: 'buffer', maxBuffer: 30 * 1024 * 1024 + 1 },
  );
  return { workingDirectory, head, content: content as Buffer };
}

export async function handleFeishuDocumentCommand(
  command: ParsedFeishuCommand,
  context?: FeishuConversationContext,
  source?: { workingDirectory: string; ref: string; expectedHead?: string },
) {
  const documentPath = normalizeRepositoryMarkdownPath(command.args.join(' '));
  if (!documentPath) return '用法：/ap doc <仓库内已提交的 Markdown 路径>';
  try {
    const { workingDirectory, head, content } = await readRepositoryMarkdown(documentPath, context, source);
    const name = path.posix.basename(documentPath, '.md');
    const url = await importMarkdownAsFeishuDocument({
      content: content.toString('utf8'),
      name,
      idempotencyKey: `${workingDirectory}:${head}:${documentPath}`,
      signal: AbortSignal.timeout(120_000),
    });
    return [
      `✅ 已转为飞书文档：[${name}](${url})`,
      `来源：${documentPath}`,
      `Git HEAD：${head}`,
    ].join('\n');
  } catch (error) {
    return `❌ 文档转换失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function handleFeishuOriginalDocumentCommand(args: {
  documentPath: string;
  context: FeishuConversationContext;
  source?: { workingDirectory: string; ref: string; expectedHead?: string };
}) {
  const documentPath = normalizeRepositoryMarkdownPath(args.documentPath);
  if (!documentPath) return '所选文档路径无效。';
  try {
    const { content } = await readRepositoryMarkdown(documentPath, args.context, args.source);
    if (!args.context.chatId) return '无法确定飞书会话。';
    await sendFeishuMarkdownFile({
      chatId: args.context.chatId,
      fileName: path.posix.basename(documentPath),
      content,
      replyId: args.context.messageId || undefined,
    });
    return `✅ 已发送原始 MD 文件：${documentPath}`;
  } catch (error) {
    return `❌ 发送 MD 文件失败：${error instanceof Error ? error.message : String(error)}`;
  }
}
