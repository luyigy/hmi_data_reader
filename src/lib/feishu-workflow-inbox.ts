import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { isFeishuAdmin } from '@/lib/feishu-access-approval';
import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import type { FeishuConversationContext } from '@/lib/feishu-live-room';
import { prisma } from '@/lib/prisma';
import {
  loadProjectsConfig,
  type JobConfig,
  type ProjectConfig,
  type ProjectsConfig,
} from '@/lib/scheduled-jobs/project-config';
import { readWorkflowContract, workflowFrontMatter } from '@/lib/scheduled-jobs/workflow-validator';

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execFileAsync(
  'git', ['-C', cwd, ...args], { encoding: 'utf8' },
)).stdout.trim();
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

export const canManageWorkflowInbox = (senderOpenId: string, admin: boolean, approvers: string[]) =>
  admin || approvers.includes(senderOpenId);

export const validateWorkflowInboxInput = (titleInput: string, bodyInput = '') => {
  const title = titleInput.trim();
  const body = bodyInput.trim();
  if (!title || title.length > 120) throw new Error('标题长度必须为 1–120 个字符。');
  if (body.length > 4000) throw new Error('说明长度不能超过 4000 个字符。');
  if (/[\u0000-\u001f\u007f]/.test(title) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) {
    throw new Error('标题或说明包含控制字符。');
  }
  if (title.includes('..') || /[/\\]/.test(title)) throw new Error('标题不能包含路径字符。');
  if (/(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|credential)\s*[:=]\s*\S+/i.test(`${title}\n${body}`)) {
    throw new Error('标题或说明疑似包含密码、Token 或密钥字段，请移除敏感值。');
  }
  return { title, body };
};

const workflowConsumers = (config: ProjectsConfig, project: ProjectConfig, branchSpace: string) =>
  config.projects.flatMap((candidate) => candidate.path === project.path && candidate.ref === project.ref
    ? candidate.jobs.filter((job) => job.type === 'workflow_watcher'
      && String(job.config.branch_space || '') === branchSpace)
    : []);

const existingIssue = async (cwd: string, head: string, inboxRoot: string, markers: string[]) => {
  for (const marker of markers) {
    const match = await git(cwd, 'grep', '-l', '-F', '--', marker, head, '--', inboxRoot).catch(() => '');
    if (match) return match.split('\n')[0].replace(`${head}:`, '');
  }
  return null;
};

export async function addWorkflowInboxIssue(args: {
  config: ProjectsConfig;
  project: ProjectConfig;
  job: JobConfig;
  expectedHead: string;
  title: string;
  body?: string;
  requestId: string;
  now?: Date;
}) {
  const { title, body } = validateWorkflowInboxInput(args.title, args.body);
  const branchSpace = String(args.job.config.branch_space || '');
  if (!branchSpace || branchSpace.includes('/') || branchSpace === '..') {
    throw new Error('workflow_watcher 需要单目录 branch_space。');
  }
  if (workflowConsumers(args.config, args.project, branchSpace).length !== 1) {
    throw new Error('目标仓库的 Workflow consumer 不唯一，拒绝录入。');
  }
  if (!args.project.ref.startsWith('refs/heads/')) throw new Error('Inbox 录入只支持 branch ref。');
  const checkedOutRef = await git(args.project.path, 'symbolic-ref', '--quiet', 'HEAD').catch(() => '');
  if (checkedOutRef !== args.project.ref) throw new Error(`目标工作区未检出 ${args.project.ref}。`);

  const currentHead = await git(args.project.path, 'rev-parse', args.project.ref);
  const contractPath = String(args.job.config.contract_path || 'docs/workflow/workflow-contract.yaml');
  if (path.isAbsolute(contractPath) || contractPath.split('/').includes('..')) {
    throw new Error('contract_path 必须位于目标仓库内。');
  }
  const contract = await readWorkflowContract(
    args.project.path,
    currentHead,
    contractPath,
    new AbortController().signal,
  );
  const allowedTypes = (contract.documents as typeof contract.documents & { allowed_types?: string[] }).allowed_types;
  if (!allowedTypes?.includes('ISSUE')
    || !contract.documents.statuses.includes('draft')
    || !contract.actions.terminal.includes('none')) {
    throw new Error('目标 Workflow 合同不允许 draft ISSUE / next_action none。');
  }
  const watchRoot = path.posix.join(contract.branch_spaces.root, branchSpace);
  const inboxRoot = path.posix.join(watchRoot, 'inbox');
  const contentKey = hash(`${args.project.id}\0${title}\0${body}`);
  const requestKey = hash(`${args.project.id}\0${args.requestId}`);
  const markers = [
    `<!-- WORKFLOW_INBOX_REQUEST: ${requestKey} -->`,
    `<!-- WORKFLOW_INBOX_CONTENT: ${contentKey} -->`,
  ];
  const existing = await existingIssue(args.project.path, currentHead, inboxRoot, markers);
  if (existing) return { state: 'existing' as const, path: existing, head: currentHead };
  if (currentHead !== args.expectedHead) return { state: 'stale' as const, head: currentHead };
  if (await git(args.project.path, 'diff', '--name-only', '--diff-filter=U')) {
    throw new Error('目标工作区存在冲突，拒绝录入。');
  }
  if (await git(args.project.path, 'status', '--porcelain')) throw new Error('目标工作区非 clean，拒绝录入。');

  const names = (await git(args.project.path, 'ls-tree', '-r', '--name-only', currentHead, '--', watchRoot))
    .split('\n').filter(Boolean);
  let number = Math.max(0, ...names.map((name) => Number(path.posix.basename(name).match(/^(\d+)_/)?.[1] || 0))) + 1;
  const width = contract.numbering.width;
  const date = (args.now ?? new Date()).toISOString().slice(0, 10).replace(/-/g, '');
  const slug = title.normalize('NFKC').replace(/[^\w\u3400-\u9fff]+/g, '').slice(0, 40) || 'Inbox';
  await fs.mkdir(path.join(args.project.path, inboxRoot), { recursive: true });

  let issuePath = '';
  while (!issuePath) {
    const candidate = path.posix.join(
      inboxRoot,
      `${String(number).padStart(width, '0')}_ISSUE_${date}_${slug}.md`,
    );
    const content = [
      '---',
      'doc_type: ISSUE',
      'doc_status: draft',
      'next_action: none',
      '---',
      '',
      `# ISSUE · ${title}`,
      '',
      ...markers,
      '',
      '## 说明',
      '',
      body || '（未提供）',
      '',
    ].join('\n');
    const metadata = workflowFrontMatter(content);
    if (metadata.doc_type !== 'ISSUE' || metadata.doc_status !== 'draft' || metadata.next_action !== 'none') {
      throw new Error('生成的 ISSUE frontmatter 不符合目标合同。');
    }
    try {
      await fs.writeFile(path.join(args.project.path, candidate), content, { encoding: 'utf8', flag: 'wx' });
      issuePath = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      number += 1;
    }
  }

  const cleanup = async () => {
    await git(args.project.path, 'restore', '--staged', '--', issuePath).catch(() => undefined);
    await fs.unlink(path.join(args.project.path, issuePath)).catch(() => undefined);
  };
  try {
    if ((await git(args.project.path, 'rev-parse', args.project.ref)) !== args.expectedHead) {
      await cleanup();
      return { state: 'stale' as const, head: await git(args.project.path, 'rev-parse', args.project.ref) };
    }
    const changes = (await git(args.project.path, '-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all'))
      .split('\n').filter(Boolean);
    if (changes.length !== 1 || changes[0] !== `?? ${issuePath}`) {
      await cleanup();
      throw new Error('目标工作区在提交前发生变化，拒绝录入。');
    }
    await git(args.project.path, 'add', '--', issuePath);
    await git(
      args.project.path,
      'commit', '--only', '-m', `docs(inbox): add ${String(number).padStart(width, '0')} issue`, '--', issuePath,
    );
    return { state: 'created' as const, path: issuePath, head: await git(args.project.path, 'rev-parse', 'HEAD') };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function handleWorkflowInboxCommand(
  command: ParsedFeishuCommand,
  context?: FeishuConversationContext,
) {
  if (!context) return '当前 inbox 命令需要来自 Feishu webhook 的会话上下文。';
  if (command.args[0] !== 'add'
    || command.args.length < 2
    || Object.keys(command.options).some((key) => !['body', 'head'].includes(key))
    || !/^[0-9a-f]{40}$/.test(command.options.head || '')) {
    return '用法：/ap inbox add <标题> [--body=<说明>] --head=<40位HEAD>';
  }
  const config = await loadProjectsConfig();
  const projects = config.projects.filter((project) => project.feishu.chat_id === context.chatId
    || project.jobs.some((job) => job.type === 'workflow_watcher' && job.config.coding_bot_chat_id === context.chatId));
  if (projects.length !== 1) return '当前 Feishu 会话未唯一绑定 Workflow 项目。';
  const project = projects[0];
  const jobs = project.jobs.filter((job) => job.type === 'workflow_watcher');
  if (jobs.length !== 1) return '当前项目未唯一配置 workflow-watcher。';
  if (!canManageWorkflowInbox(
    context.senderOpenId,
    isFeishuAdmin(context.senderOpenId),
    project.feishu.approver_open_ids,
  )) {
    return '只有平台管理员或项目审批人可以录入 Workflow Inbox。';
  }
  const title = command.args.slice(1).join(' ');
  const expectedHead = command.options.head;
  const requestId = context.messageId || `${context.senderOpenId}:${expectedHead}:${hash(`${title}\0${command.options.body || ''}`)}`;
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${project.id}:${jobs[0].id}`}, 0))::text`;
      return addWorkflowInboxIssue({
        config,
        project,
        job: jobs[0],
        expectedHead,
        title,
        body: command.options.body,
        requestId,
      });
    });
    if (result.state === 'stale') {
      return `❌ 命令已过期：预期 HEAD ${expectedHead}，当前 HEAD ${result.head}。`;
    }
    return result.state === 'existing'
      ? `✅ Inbox ISSUE 已存在（幂等，无提交）：${result.path}\nHEAD：${result.head}`
      : `✅ 已创建 draft Inbox ISSUE：${result.path}\n新 HEAD：${result.head}`;
  } catch (error) {
    return `❌ Inbox 录入失败：${error instanceof Error ? error.message : String(error)}`;
  }
}
