import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseDocument } from 'yaml';
import { isFeishuAdmin } from '@/lib/feishu-access-approval';
import { sendFeishuInteractiveMessage } from '@/lib/feishu-api';
import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import type { FeishuConversationContext } from '@/lib/feishu-live-room';
import { prisma } from '@/lib/prisma';
import {
  findProjectByChatId,
  loadProjectsConfig,
} from '@/lib/scheduled-jobs/project-config';
import {
  buildWorkflowPermissionSnapshot,
  formatWorkflowPermissionSnapshot,
  validateWorkflowExecutionPolicy,
  workflowPolicySource,
  type WorkflowExecutionPolicy,
} from '@/lib/workflow-execution-policy';
import {
  formatWorkflowStatus,
  loadWorkflowStatusForChat,
} from '@/lib/scheduled-jobs/workflow-status';
import {
  canManageWorkflowAutonomy,
  decideWorkflowAutonomyChange,
  isWorkflowAutonomy,
  isWorkflowRoleLevel,
  resolveWorkflowAutonomy,
  resolveWorkflowRoleLevel,
  storedWorkflowRoleLevel,
  workflowPreferencesWithRoleLevel,
} from '@/lib/scheduled-jobs/workflow-autonomy';
import { handleWorkflowValidationCommand } from '@/lib/feishu-workflow-validation';

const configFile = () => path.join(process.cwd(), 'config/projects.yaml');
const execFileAsync = promisify(execFile);
async function writeWorkflowPolicy(projectId: string, jobId: string, policy: WorkflowExecutionPolicy) {
  const file = configFile();
  const mode = (await fs.stat(file)).mode & 0o777;
  const document = parseDocument(await fs.readFile(file, 'utf8'));
  const projects = document.get('projects') as { items?: Array<{ get(key: string): unknown }> };
  const projectIndex = projects?.items?.findIndex((item) => item.get('id') === projectId) ?? -1;
  const jobs = projectIndex >= 0
    ? document.getIn(['projects', projectIndex, 'jobs']) as { items?: Array<{ get(key: string): unknown }> }
    : null;
  const jobIndex = jobs?.items?.findIndex((item) => item.get('id') === jobId) ?? -1;
  if (projectIndex < 0 || jobIndex < 0) throw new Error(`workflow watcher config not found: ${projectId}/${jobId}`);
  document.setIn(
    ['projects', projectIndex, 'jobs', jobIndex, 'config', 'execution_policy'],
    document.createNode(policy),
  );
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, document.toString(), { encoding: 'utf8', mode });
  await fs.rename(temporary, file);
}

export async function handleWorkflowPolicyCommand(
  command: ParsedFeishuCommand,
  context?: FeishuConversationContext,
) {
  if (!context) return '当前 workflow 命令需要来自 Feishu webhook 的会话上下文。';
  if (command.args[0] === 'validation') return handleWorkflowValidationCommand(command, context);
  if (command.args[0] === 'status' && command.args.length === 1 && !Object.keys(command.options).length) {
    const status = await loadWorkflowStatusForChat(context.chatId);
    return status ? formatWorkflowStatus(status) : '当前 Feishu 会话未绑定 Workflow 项目。';
  }
  if (command.args[0] === 'level') {
    const project = findProjectByChatId(await loadProjectsConfig(), context.chatId);
    if (!project) return '当前 Feishu 会话未绑定 Workflow 项目。';
    const job = project.jobs.find((candidate) => candidate.type === 'workflow_watcher');
    if (!job) return '当前项目未配置 workflow-watcher。';
    const action = command.args[1];
    if (action === 'show' && command.args.length === 2 && !Object.keys(command.options).length) {
      const state = await prisma.scheduledJobState.findUnique({
        where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
        select: { workflowAutonomy: true },
      });
      return `Workflow 执行档位：${resolveWorkflowRoleLevel(state?.workflowAutonomy)}（后续 Slice 生效）`;
    }
    if (action !== 'set' || command.args.length !== 3 || !isWorkflowRoleLevel(command.args[2])
      || Object.keys(command.options).length) {
      return '用法：/ap workflow level show | /ap workflow level set <full|lean|fast>';
    }
    if (!canManageWorkflowAutonomy(
      context.senderOpenId,
      isFeishuAdmin(context.senderOpenId),
      project.feishu.approver_open_ids,
    )) return '只有平台管理员或项目审批人可以切换 Workflow 执行档位。';
    const level = command.args[2];
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${project.id}:${job.id}`}, 0))::text
      `;
      const currentHead = (await execFileAsync(
        'git', ['-C', project.path, 'rev-parse', project.ref], { encoding: 'utf8' },
      )).stdout.trim();
      const state = await tx.scheduledJobState.upsert({
        where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
        create: { projectId: project.id, jobId: job.id },
        update: {},
      });
      if (storedWorkflowRoleLevel(state.workflowAutonomy) === level) return 'unchanged' as const;
      await tx.scheduledJobState.update({
        where: { id: state.id },
        data: { workflowAutonomy: workflowPreferencesWithRoleLevel({
          job,
          stored: state.workflowAutonomy,
          level,
          expectedHead: currentHead,
          requestId: context.messageId || `${context.senderOpenId}:${level}`,
          updatedBy: context.senderOpenId,
        }) },
      });
      return 'updated' as const;
    });
    return result === 'unchanged'
      ? `✅ Workflow 执行档位已经是 ${level}（幂等，无写入）。后续 Slice 生效。`
      : `✅ Workflow 执行档位已切换为 ${level}。当前执行中的阶段不变，后续 Slice 生效。`;
  }
  if (command.args[0] === 'autonomy') {
    const project = findProjectByChatId(await loadProjectsConfig(), context.chatId);
    if (!project) return '当前 Feishu 会话未绑定 Workflow 项目。';
    const job = project.jobs.find((candidate) => candidate.type === 'workflow_watcher');
    if (!job) return '当前项目未配置 workflow-watcher。';
    const action = command.args[1];
    if (action === 'show' && command.args.length === 2 && !Object.keys(command.options).length) {
      const status = await loadWorkflowStatusForChat(context.chatId);
      return status
        ? `Workflow 自治模式：${status.autonomy}（${status.autonomySource}）\nHEAD：${status.head}`
        : 'Workflow 状态不可用。';
    }
    if (action !== 'set'
      || command.args.length !== 3
      || !isWorkflowAutonomy(command.args[2])
      || Object.keys(command.options).some((key) => key !== 'head')
      || !/^[0-9a-f]{40}$/.test(command.options.head || '')) {
      return '用法：/ap workflow autonomy show | /ap workflow autonomy set <manual|semi_auto|auto> --head=<40位HEAD>';
    }
    if (!canManageWorkflowAutonomy(
      context.senderOpenId,
      isFeishuAdmin(context.senderOpenId),
      project.feishu.approver_open_ids,
    )) {
      return '只有平台管理员或项目审批人可以切换 Workflow 自治模式。';
    }
    const requested = command.args[2];
    const expectedHead = command.options.head;
    const requestId = context.messageId || `${context.senderOpenId}:${expectedHead}:${requested}`;
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${project.id}:${job.id}`}, 0))::text
      `;
      const currentHead = (await execFileAsync(
        'git',
        ['-C', project.path, 'rev-parse', project.ref],
        { encoding: 'utf8' },
      )).stdout.trim();
      const state = await tx.scheduledJobState.findUnique({
        where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
      });
      const current = resolveWorkflowAutonomy(job, state?.workflowAutonomy);
      const decision = decideWorkflowAutonomyChange({
        currentMode: current.mode,
        currentHead,
        expectedHead,
        requestedMode: requested,
      });
      if (decision === 'stale') return { state: 'stale' as const, currentHead };
      if (decision === 'unchanged') {
        return { state: 'unchanged' as const, currentHead, source: current.source };
      }
      const stateId = state?.id ?? (await tx.scheduledJobState.create({
        data: { projectId: project.id, jobId: job.id },
      })).id;
      await tx.scheduledJobState.update({
        where: { id: stateId },
        data: {
          workflowAutonomy: {
            mode: requested,
            ...(storedWorkflowRoleLevel(state?.workflowAutonomy)
              ? { roleWorkflowLevel: storedWorkflowRoleLevel(state?.workflowAutonomy) }
              : {}),
            expectedHead,
            requestId,
            updatedBy: context.senderOpenId,
            updatedAt: new Date().toISOString(),
          },
        },
      });
      return { state: 'updated' as const, currentHead, source: 'override' as const };
    });
    if (result.state === 'stale') {
      return `❌ 卡片或命令已过期：预期 HEAD ${expectedHead}，当前 HEAD ${result.currentHead}。请刷新 Workflow Dashboard。`;
    }
    return result.state === 'unchanged'
      ? `✅ Workflow 自治模式已经是 ${requested}（幂等，无写入）。HEAD：${result.currentHead}`
      : `✅ Workflow 自治模式已切换为 ${requested}。HEAD：${result.currentHead}`;
  }
  if (command.args[0] !== 'policy' || !['show', 'set', 'edit'].includes(command.args[1] || '')) {
    return '用法：/ap workflow status | /ap workflow level <show|set> | /ap workflow autonomy <show|set> | /ap workflow validation <show|set|template|repair> | /ap workflow policy <show|set|edit>';
  }
  const setting = command.args[1] === 'set';
  const editing = command.args[1] === 'edit';
  const project = findProjectByChatId(
    await loadProjectsConfig(undefined, undefined, { allowMissingWorkflowPolicy: setting }),
    context.chatId,
  );
  if (!project) return '当前 Feishu 会话未绑定 Workflow 项目。';
  const job = project.jobs.find((candidate) => candidate.type === 'workflow_watcher');
  if (!job) return '当前项目未配置 workflow-watcher。';
  const source = workflowPolicySource(project.id, job.id);
  const before = job.config.execution_policy === undefined && setting
    ? null
    : validateWorkflowExecutionPolicy(job.config.execution_policy, source);
  const snapshot = buildWorkflowPermissionSnapshot({
    policy: before ?? { preset: 'workspace' },
    projectPath: project.path,
    source,
  });
  if (!setting && !editing) return formatWorkflowPermissionSnapshot(snapshot);

  if (!isFeishuAdmin(context.senderOpenId)) return '仅配置的 Feishu 管理员可以设置 Workflow 权限策略。';
  if (editing) {
    await sendWorkflowPolicyEditCard({
      projectId: project.id,
      jobId: job.id,
      projectPath: project.path,
      chatId: context.chatId,
      before,
    });
    return '🔧 已发送 Workflow 额外挂载配置卡片，请在卡片中修改并提交（下次 watcher 加载生效）。';
  }
  const allowedPolicyOptions = ['preset', 'extra-read', 'extra-write'];
  const unknownPolicyOptions = Object.keys(command.options).filter((key) => !allowedPolicyOptions.includes(key));
  if (command.args.length !== 2
    || command.options.preset !== 'workspace'
    || unknownPolicyOptions.length) {
    return [
      '用法：/ap workflow policy set --preset=workspace [--extra-read=<逗号分隔绝对路径>] [--extra-write=<逗号分隔绝对路径>]',
      '--extra-read=只读额外挂载；--extra-write=可写额外挂载。两者缺省保留现状，传空值（--extra-read=）可清空。',
    ].join('\n');
  }

  const parseExtraList = (raw: string | undefined): string[] | undefined =>
    raw === undefined ? undefined : raw.split(',').map((item) => item.trim()).filter(Boolean);
  const workspaceExtras = (policy: WorkflowExecutionPolicy) =>
    policy.preset === 'workspace'
      ? { extraReadOnlyPaths: policy.extraReadOnlyPaths ?? [], extraWritableRoots: policy.extraWritableRoots ?? [] }
      : { extraReadOnlyPaths: [] as string[], extraWritableRoots: [] as string[] };
  const base = before ?? { preset: 'workspace' as const };
  const currentExtras = workspaceExtras(base);
  const extraReadOnlyPaths = parseExtraList(command.options['extra-read']) ?? currentExtras.extraReadOnlyPaths;
  const extraWritableRoots = parseExtraList(command.options['extra-write']) ?? currentExtras.extraWritableRoots;
  let after: WorkflowExecutionPolicy;
  try {
    after = validateWorkflowExecutionPolicy({
      preset: 'workspace',
      ...(extraWritableRoots.length ? { extraWritableRoots } : {}),
      ...(extraReadOnlyPaths.length ? { extraReadOnlyPaths } : {}),
    }, source);
  } catch (error) {
    return `❌ ${error instanceof Error ? error.message : String(error)}`;
  }
  const afterSnapshot = buildWorkflowPermissionSnapshot({
    policy: after,
    projectPath: project.path,
    source,
  });

  const audit = await prisma.feishuAdminApproval.create({
    data: {
      kind: 'workflow_policy_set',
      status: 'processing',
      requesterOpenId: context.senderOpenId,
      requesterChatId: context.chatId,
      payloadJson: JSON.stringify({
        projectId: project.id,
        jobId: job.id,
        source,
        before,
        after,
        effective: 'next_watcher_load',
      }),
      resolvedBy: context.senderOpenId,
    },
  });
  try {
    await writeWorkflowPolicy(project.id, job.id, after);
    await prisma.feishuAdminApproval.update({
      where: { id: audit.id },
      data: { status: 'approved', resolvedAt: new Date() },
    });
  } catch (error) {
    await prisma.feishuAdminApproval.update({
      where: { id: audit.id },
      data: { status: 'denied', resolvedAt: new Date() },
    }).catch(() => undefined);
    throw error;
  }
  const afterExtras = workspaceExtras(after);
  const afterSummary = `preset=workspace${afterExtras.extraWritableRoots.length ? ` extraWritableRoots=${afterExtras.extraWritableRoots.join(',')}` : ''}${afterExtras.extraReadOnlyPaths.length ? ` extraReadOnlyPaths=${afterExtras.extraReadOnlyPaths.join(',')}` : ''}`;
  return [
    '✅ Workflow 权限策略已设置。',
    `before: ${before ? `preset=${before.preset}` : 'unset'}`,
    `after: ${afterSummary}`,
    `operator: ${context.senderOpenId}`,
    `audit: ${audit.id}`,
    'effective: next watcher config load',
    formatWorkflowPermissionSnapshot(afterSnapshot),
  ].join('\n');
}

export async function sendWorkflowPolicyEditCard(args: {
  projectId: string;
  jobId: string;
  projectPath: string;
  chatId: string;
  before: WorkflowExecutionPolicy | null;
}) {
  const source = workflowPolicySource(args.projectId, args.jobId);
  const readExtras = (policy: WorkflowExecutionPolicy) =>
    policy.preset === 'workspace'
      ? { extraReadOnlyPaths: policy.extraReadOnlyPaths ?? [], extraWritableRoots: policy.extraWritableRoots ?? [] }
      : { extraReadOnlyPaths: [] as string[], extraWritableRoots: [] as string[] };
  const current = args.before ? readExtras(args.before) : { extraReadOnlyPaths: [], extraWritableRoots: [] };
  await sendFeishuInteractiveMessage({
    receiveId: args.chatId,
    card: {
      schema: '2.0',
      config: { update_multi: true, width_mode: 'default' },
      header: { template: 'blue', title: { tag: 'plain_text', content: '🔧 Workflow 额外挂载配置' } },
      body: {
        elements: [
          { tag: 'markdown', content: [
            `**项目：** ${args.projectId}（\`${args.projectPath}\`）`,
            `**来源：** ${source}`,
            '在下方填写需要额外挂载进沙箱的目录（逗号分隔绝对路径）。**全量覆盖**：提交后以此处内容为准；某项留空 = 清空该项。',
            '',
            `当前只读挂载：\`${current.extraReadOnlyPaths.join(', ') || '（无）'}\``,
            `当前可写挂载：\`${current.extraWritableRoots.join(', ') || '（无）'}\``,
          ].join('\n') },
          {
            tag: 'form',
            name: `workflowPolicyEdit_${args.projectId}`,
            elements: [
              { tag: 'input', name: 'extraRead', placeholder: { tag: 'plain_text', content: '/data1/code/repo-a,/data1/code/repo-b' }, default_value: current.extraReadOnlyPaths.join(','), label: { tag: 'plain_text', content: '额外只读挂载 (extra-read)' } },
              { tag: 'input', name: 'extraWrite', placeholder: { tag: 'plain_text', content: '/data1/code/repo-c' }, default_value: current.extraWritableRoots.join(','), label: { tag: 'plain_text', content: '额外可写挂载 (extra-write)' } },
              { tag: 'button', name: `submitWorkflowPolicy_${args.projectId}`, type: 'primary', text: { tag: 'plain_text', content: '提交' }, value: { cmd: `workflow-policy:${args.projectId}:${args.jobId}` }, form_action_type: 'submit' },
            ],
          },
        ],
      },
    },
  });
}

export async function applyWorkflowPolicyCard(args: {
  projectId: string;
  jobId: string;
  extraReadRaw?: string;
  extraWriteRaw?: string;
  operatorOpenId: string;
}): Promise<{ ok: boolean; message: string }> {
  const source = workflowPolicySource(args.projectId, args.jobId);
  const cfg = await loadProjectsConfig(undefined, undefined, { allowMissingWorkflowPolicy: true });
  const project = cfg.projects.find((candidate) => candidate.id === args.projectId);
  if (!project) return { ok: false, message: `未找到项目：${args.projectId}` };
  const job = project.jobs.find((candidate) => candidate.id === args.jobId && candidate.type === 'workflow_watcher');
  if (!job) return { ok: false, message: `未找到 workflow-watcher：${args.projectId}/${args.jobId}` };
  const before = job.config.execution_policy === undefined ? null : validateWorkflowExecutionPolicy(job.config.execution_policy, source);
  const splitPaths = (raw: string | undefined): string[] =>
    raw === undefined ? [] : raw.split(',').map((item) => item.trim()).filter(Boolean);
  const readExtras = (policy: WorkflowExecutionPolicy) =>
    policy.preset === 'workspace'
      ? { extraReadOnlyPaths: policy.extraReadOnlyPaths ?? [], extraWritableRoots: policy.extraWritableRoots ?? [] }
      : { extraReadOnlyPaths: [] as string[], extraWritableRoots: [] as string[] };
  const base = before ?? { preset: 'workspace' as const };
  const currentExtras = readExtras(base);
  const extraReadOnlyPaths = args.extraReadRaw === undefined ? currentExtras.extraReadOnlyPaths : splitPaths(args.extraReadRaw);
  const extraWritableRoots = args.extraWriteRaw === undefined ? currentExtras.extraWritableRoots : splitPaths(args.extraWriteRaw);
  let after: WorkflowExecutionPolicy;
  try {
    after = validateWorkflowExecutionPolicy({ preset: 'workspace', ...(extraWritableRoots.length ? { extraWritableRoots } : {}), ...(extraReadOnlyPaths.length ? { extraReadOnlyPaths } : {}) }, source);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const audit = await prisma.feishuAdminApproval.create({
    data: {
      kind: 'workflow_policy_set',
      status: 'processing',
      requesterOpenId: args.operatorOpenId,
      requesterChatId: args.operatorOpenId || 'feishu_card',
      payloadJson: JSON.stringify({ projectId: args.projectId, jobId: args.jobId, source, before, after, effective: 'next_watcher_load', via: 'card' }),
      resolvedBy: args.operatorOpenId,
    },
  });
  try {
    await writeWorkflowPolicy(args.projectId, args.jobId, after);
    await prisma.feishuAdminApproval.update({ where: { id: audit.id }, data: { status: 'approved', resolvedAt: new Date() } });
  } catch (error) {
    await prisma.feishuAdminApproval.update({ where: { id: audit.id }, data: { status: 'denied', resolvedAt: new Date() } }).catch(() => undefined);
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const afterExtras = readExtras(after);
  const summary = `preset=workspace${afterExtras.extraWritableRoots.length ? ` extraWritableRoots=${afterExtras.extraWritableRoots.join(',')}` : ''}${afterExtras.extraReadOnlyPaths.length ? ` extraReadOnlyPaths=${afterExtras.extraReadOnlyPaths.join(',')}` : ''}`;
  return { ok: true, message: `已更新：${summary}（下次 watcher 加载生效）` };
}
