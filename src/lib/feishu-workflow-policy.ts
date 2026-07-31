import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseDocument } from 'yaml';
import { isFeishuAdmin } from '@/lib/feishu-access-approval';
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
} from '@/lib/workflow-execution-policy';
import {
  formatWorkflowStatus,
  loadWorkflowStatusForChat,
} from '@/lib/scheduled-jobs/workflow-status';
import {
  canManageWorkflowAutonomy,
  decideWorkflowAutonomyChange,
  isWorkflowAutonomy,
  resolveWorkflowAutonomy,
} from '@/lib/scheduled-jobs/workflow-autonomy';

const configFile = () => path.join(process.cwd(), 'config/projects.yaml');
const execFileAsync = promisify(execFile);
async function writeWorkflowPolicy(projectId: string, jobId: string) {
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
    { preset: 'workspace' },
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
  if (command.args[0] === 'status' && command.args.length === 1 && !Object.keys(command.options).length) {
    const status = await loadWorkflowStatusForChat(context.chatId);
    return status ? formatWorkflowStatus(status) : '当前 Feishu 会话未绑定 Workflow 项目。';
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
  if (command.args[0] !== 'policy' || !['show', 'set'].includes(command.args[1] || '')) {
    return '用法：/ap workflow status | /ap workflow autonomy <show|set> | /ap workflow policy <show|set>';
  }
  const setting = command.args[1] === 'set';
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
  if (!setting) return formatWorkflowPermissionSnapshot(snapshot);

  if (!isFeishuAdmin(context.senderOpenId)) return '仅配置的 Feishu 管理员可以设置 Workflow 权限策略。';
  if (command.options.preset !== 'workspace'
    || command.args.length !== 2
    || Object.keys(command.options).some((key) => key !== 'preset')) {
    return '仅支持：/ap workflow policy set --preset=workspace';
  }

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
        after: { preset: 'workspace' },
        effective: 'next_watcher_load',
      }),
      resolvedBy: context.senderOpenId,
    },
  });
  try {
    await writeWorkflowPolicy(project.id, job.id);
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
  return [
    '✅ Workflow 权限策略已设置。',
    `before: ${before ? `preset=${before.preset}` : 'unset'}`,
    'after: preset=workspace',
    `operator: ${context.senderOpenId}`,
    `audit: ${audit.id}`,
    'effective: next watcher config load',
    formatWorkflowPermissionSnapshot(snapshot),
  ].join('\n');
}
