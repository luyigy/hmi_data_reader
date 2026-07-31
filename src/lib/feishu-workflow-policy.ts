import { promises as fs } from 'node:fs';
import path from 'node:path';
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

const configFile = () => path.join(process.cwd(), 'config/projects.yaml');
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
  if (command.args[0] !== 'policy' || !['show', 'set'].includes(command.args[1] || '')) {
    return '用法：/ap workflow status | /ap workflow policy show | /ap workflow policy set --preset=workspace';
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
