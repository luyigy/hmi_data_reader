import { prisma } from '@/lib/prisma';
import { isFeishuAdmin } from '@/lib/feishu-access-approval';
import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import type { FeishuConversationContext } from '@/lib/feishu-live-room';
import { jobHandlers } from '@/lib/scheduled-jobs/handlers';
import { findProjectByChatId, loadProjectsConfig } from '@/lib/scheduled-jobs/project-config';
import { executeScheduledJob, stopScheduledJob } from '@/lib/scheduled-jobs/runner';

const date = (value: Date | null | undefined) => value?.toISOString() ?? '-';

export const formatManualRunResult = (
  jobId: string,
  run: { status: string; summary?: string | null; error?: string | null } | null,
) => {
  if (run?.status === 'succeeded') return `✅ ${jobId} 手动执行完成。`;
  if (run?.status === 'failed' || run?.status === 'timed_out') {
    return `❌ ${jobId} 手动执行${run.status === 'timed_out' ? '超时' : '失败'}：${run.error ?? run.summary ?? '未知错误'}`;
  }
  return `${jobId} 未执行（${run?.summary ?? '重复或未创建运行记录'}）。`;
};

export async function handleScheduledJobCommand(
  command: ParsedFeishuCommand,
  context?: FeishuConversationContext,
) {
  if (!context) return '当前 job 命令需要来自 Feishu webhook 的会话上下文。';

  const project = findProjectByChatId(await loadProjectsConfig(), context.chatId);
  if (!project) return '当前 Feishu 会话未绑定定时任务项目。';

  const action = command.command === 'jobs' ? 'list' : command.args[0]?.toLowerCase();
  const jobId = command.args[1];
  if (action !== 'list' && (!jobId || !['status', 'enable', 'disable', 'run', 'stop'].includes(action || ''))) {
    return '用法：/ap jobs | /ap job <status|enable|disable|run|stop> <job-id>';
  }

  const states = await prisma.scheduledJobState.findMany({ where: { projectId: project.id } });
  const running = new Set((await prisma.scheduledJobRun.findMany({
    where: { projectId: project.id, status: 'running' },
    select: { jobId: true },
  })).map(({ jobId }) => jobId));
  const stateByJob = new Map(states.map((state) => [state.jobId, state]));
  if (action === 'list') {
    return project.jobs.map((job) => {
      const state = stateByJob.get(job.id);
      return `${job.id}: ${state?.enabledOverride ?? job.enabled ? 'enabled' : 'disabled'} · ${running.has(job.id) ? 'running' : 'idle'} · ${state?.modeOverride ?? job.mode} · ${job.schedule}`;
    }).join('\n');
  }

  const job = project.jobs.find((candidate) => candidate.id === jobId);
  if (!job) return `未注册 job：${jobId}`;
  const state = stateByJob.get(job.id);
  if (action === 'status') {
    return [
      `${project.name} / ${job.id}`,
      `repo: ${project.path}`,
      `ref: ${project.ref}`,
      `schedule: ${job.schedule}`,
      `enabled: ${state?.enabledOverride ?? job.enabled}`,
      `running: ${running.has(job.id)}`,
      `mode: ${state?.modeOverride ?? job.mode}`,
      `last run: ${date(state?.lastFinishedAt)}`,
      `last success: ${date(state?.lastSuccessAt)}`,
      `last error: ${state?.lastError ?? '-'}`,
    ].join('\n');
  }

  if (!isFeishuAdmin(context.senderOpenId) && !project.feishu.approver_open_ids.includes(context.senderOpenId)) {
    return '只有平台管理员或项目审批人可以启停或运行 job。';
  }

  if (action === 'enable' || action === 'disable') {
    const enabled = action === 'enable';
    await prisma.scheduledJobState.upsert({
      where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
      create: { projectId: project.id, jobId: job.id, enabledOverride: enabled },
      update: { enabledOverride: enabled },
    });
    return `✅ ${job.id} 已${enabled ? '启用' : '停用'}。${!enabled && running.has(job.id) ? ' 当前执行不会被中断。' : ''}`;
  }
  if (action === 'stop') {
    return await stopScheduledJob(prisma, project.id, job.id)
      ? `✅ ${job.id} 当前执行已请求停止；启用状态未改变。`
      : `${job.id} 当前没有可停止的执行。`;
  }

  const handler = jobHandlers.get(job.type);
  if (!handler) return `job 类型未注册 handler：${job.type}`;
  const eventKey = crypto.randomUUID();
  await executeScheduledJob(prisma, project, job, new Date(), handler, 'manual', eventKey);
  const run = await prisma.scheduledJobRun.findUnique({
    where: { idempotencyKey: `manual:${project.id}:${job.id}:${eventKey}` },
    select: { status: true, summary: true, error: true },
  });
  return formatManualRunResult(job.id, run);
}
