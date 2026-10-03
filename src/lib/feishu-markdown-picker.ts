import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getBoundLiveRoom, isFeishuRoomBoundToChat, type FeishuConversationContext } from '@/lib/feishu-live-room';
import { replyFeishuMessage } from '@/lib/feishu-api';
import { assertFeishuDocumentAccess, handleFeishuOriginalDocumentCommand, normalizeRepositoryMarkdownPath } from '@/lib/feishu-document-command';
import { prisma } from '@/lib/prisma';
import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';

const execFileAsync = promisify(execFile);
const OPTIONS_PER_SECTION = 100;
const sections = [
  { key: 'handover', title: 'docs · 交接文件', matches: (file: string) => /^docs\/\d+_HANDOVER_/i.test(file) },
  { key: 'plan', title: 'docs · PLAN', matches: (file: string) => /^docs\/\d+_PLAN_/i.test(file) },
  { key: 'docs', title: 'docs · 其他', matches: (file: string) => file.startsWith('docs/') && !/^docs\/\d+_(HANDOVER|PLAN)_/i.test(file) },
  { key: 'other', title: '仓库其他位置', matches: (file: string) => !file.startsWith('docs/') },
] as const;

function compareMarkdownFiles(a: string, b: string) {
  const number = (file: string) => Number(file.split('/').pop()?.match(/^(\d+)_/)?.[1] || 0);
  return number(b) - number(a) || b.localeCompare(a, 'zh-CN', { numeric: true });
}

async function listMarkdownFiles(workingDirectory: string, head: string, filter: string) {
  const { stdout } = await execFileAsync('git', ['ls-tree', '-r', '-z', '--name-only', head], {
    cwd: workingDirectory, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.split('\0').filter((file) => file.toLowerCase().endsWith('.md')
    && (!filter || file.toLowerCase().includes(filter.toLowerCase())))
    .sort(compareMarkdownFiles);
}

export function buildMarkdownPickerCard(args: {
  roomId: string; head: string; filter: string; files: string[]; section?: string;
}) {
  const groups = sections.map((section) => ({
    ...section, files: args.files.filter(section.matches).sort(compareMarkdownFiles),
  }));
  const active = groups.find((group) => group.key === args.section) || groups.find((group) => group.files.length) || groups[0];
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '原始 MD 文件' } },
    elements: [
      { tag: 'markdown', content: `${args.files.length} 个已提交文件，编号从大到小${args.filter ? ` · 筛选：${args.filter}` : ''}\n发送 \`/ap md <关键词>\` 可筛选；发送 \`/ap md <完整路径.md>\` 可直接发送。` },
      { tag: 'action', actions: groups.map((group) => ({
        tag: 'button', type: group.key === active.key ? 'primary' : 'default',
        text: { tag: 'plain_text', content: `${group.title} (${group.files.length})` },
        value: { cmd: 'markdown-picker', action: 'view', roomId: args.roomId, head: args.head, filter: args.filter, section: group.key },
      })) },
      { tag: 'markdown', content: `**${active.title}**（${active.files.length}）${active.files.length > OPTIONS_PER_SECTION ? ' · 显示最新 100 个，旧文件请用关键词筛选' : ''}` },
      ...(active.files.length ? [{
        tag: 'form', name: `markdown-picker-${active.key}`,
        elements: [{
          tag: 'select_static', name: `selectedMarkdown_${active.key}`, required: true, width: 'fill',
          placeholder: { tag: 'plain_text', content: `选择${active.title}` },
          options: active.files.slice(0, OPTIONS_PER_SECTION).map((file) => ({
            text: { tag: 'plain_text', content: file.length > 90 ? `…${file.slice(-89)}` : file },
            value: file,
          })),
        }, {
          tag: 'button', name: 'sendMarkdown', action_type: 'form_submit', type: 'primary_filled', width: 'fill',
          text: { tag: 'plain_text', content: '发送所选 MD 文件' },
          value: { cmd: 'markdown-picker', action: 'send', roomId: args.roomId, head: args.head, filter: args.filter, section: active.key },
        }],
      }] : [{ tag: 'markdown', content: '这个分区没有匹配的 Markdown 文件。' }]),
    ],
  };
}

async function sendPicker(args: {
  context: FeishuConversationContext; roomId: string; workingDirectory: string;
  head: string; filter: string;
}) {
  const files = await listMarkdownFiles(args.workingDirectory, args.head, args.filter);
  await replyFeishuMessage({
    messageId: args.context.messageId, msgType: 'interactive',
    content: buildMarkdownPickerCard({ roomId: args.roomId, head: args.head, filter: args.filter, files }),
  });
  return `✅ 已发送原始 MD 文件选择卡（${files.length} 个文件）。`;
}

export async function handleFeishuMarkdownCommand(command: ParsedFeishuCommand, context?: FeishuConversationContext) {
  if (!context) return '当前命令需要 Feishu 会话上下文。';
  const room = await getBoundLiveRoom(context);
  const workingDirectory = room?.sourceTask?.workingDirectory || room?.workingDirectory;
  if (!room || !workingDirectory) return '当前飞书会话未绑定带工作目录的 Live Room。';
  try {
    await assertFeishuDocumentAccess(context, workingDirectory);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const query = command.args.join(' ').trim();
  if (query.toLowerCase().endsWith('.md')) {
    return handleFeishuOriginalDocumentCommand({ documentPath: query, context });
  }
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workingDirectory, encoding: 'utf8' });
  return sendPicker({ context, roomId: room.id, workingDirectory, head: stdout.trim(), filter: query });
}

export async function handleMarkdownPickerCardAction(args: {
  context: FeishuConversationContext;
  roomId: string; head: string; filter: string; section?: string;
  action: string; selectedMarkdown?: string;
}) {
  if (!await isFeishuRoomBoundToChat({ roomId: args.roomId, chatId: args.context.chatId })) {
    return '文档选择卡与当前飞书会话不匹配。';
  }
  const room = await prisma.liveRoom.findUnique({
    where: { id: args.roomId },
    select: { workingDirectory: true, sourceTask: { select: { workingDirectory: true } } },
  });
  const workingDirectory = room?.sourceTask?.workingDirectory || room?.workingDirectory;
  if (!workingDirectory) return '原始 MD 文件所在工作区已失效。';
  try {
    await assertFeishuDocumentAccess(args.context, workingDirectory);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workingDirectory, encoding: 'utf8' });
  if (stdout.trim() !== args.head) return '仓库版本已更新，请重新发送 /ap md。';
  if (args.action === 'view') {
    const files = await listMarkdownFiles(workingDirectory, args.head, args.filter);
    return buildMarkdownPickerCard({ roomId: args.roomId, head: args.head, filter: args.filter, files, section: args.section });
  }
  if (args.action !== 'send') return '文档选择卡操作无效。';
  const selected = normalizeRepositoryMarkdownPath(args.selectedMarkdown || '');
  const files = await listMarkdownFiles(workingDirectory, args.head, args.filter);
  if (!selected || !files.includes(selected)) return '所选文件不在当前列表中，请重新发送 /ap md。';
  return handleFeishuOriginalDocumentCommand({
    documentPath: selected, context: args.context,
    source: { workingDirectory, ref: 'HEAD', expectedHead: args.head },
  });
}

export async function handleMarkdownPickerCardCallback(args: {
  action: { value?: Record<string, unknown>; form_value?: Record<string, unknown> };
  openId?: string; chatId?: string; messageId?: string; prefix: string;
}) {
  const value = args.action.value || {};
  const { openId, chatId, messageId, prefix } = args;
  if (!openId || !chatId || !messageId || typeof value.roomId !== 'string'
    || typeof value.head !== 'string' || typeof value.action !== 'string') {
    return { toast: { type: 'warning', content: '文档选择卡已失效，请重新发送 /ap md' } };
  }
  const task = handleMarkdownPickerCardAction({
    context: { chatId, chatType: 'group', senderOpenId: openId, messageId },
    roomId: value.roomId, head: value.head,
    filter: typeof value.filter === 'string' ? value.filter : '',
    section: typeof value.section === 'string' ? value.section : undefined,
    action: value.action,
    selectedMarkdown: typeof value.section === 'string' && typeof args.action.form_value?.[`selectedMarkdown_${value.section}`] === 'string'
      ? args.action.form_value[`selectedMarkdown_${value.section}`] as string : undefined,
  });
  if (value.action === 'view') {
    try {
      const result = await task;
      return typeof result === 'string'
        ? { toast: { type: 'warning', content: result } }
        : { toast: { type: 'success', content: '已切换分区' }, card: { type: 'raw', data: result } };
    } catch (err) {
      console.error(`${prefix} markdown picker view failed`, { err });
      return { toast: { type: 'error', content: '切换分区失败，请重新发送 /ap md' } };
    }
  }
  void task.then((result) => replyFeishuMessage({
    messageId, msgType: 'text', content: { text: typeof result === 'string' ? result : '文档选择卡操作无效。' },
  })).catch((err) => {
    console.error(`${prefix} markdown picker action failed`, { err });
    void replyFeishuMessage({
      messageId, msgType: 'text',
      content: { text: `❌ 原始 MD 操作失败：${err instanceof Error ? err.message : String(err)}` },
    }).catch(() => undefined);
  });
  return { toast: { type: 'success', content: '操作已接收' } };
}
