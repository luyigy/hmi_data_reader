import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prisma } from '@/lib/prisma';
import { isFeishuAdmin } from '@/lib/feishu-access-approval';
import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import type { FeishuConversationContext } from '@/lib/feishu-live-room';
import { jobHandlers } from '@/lib/scheduled-jobs/handlers';
import { findProjectByChatId, loadProjectsConfig } from '@/lib/scheduled-jobs/project-config';
import { stopScheduledJob, waitForScheduledJobStop } from '@/lib/scheduled-jobs/runner';

const date = (value: Date | null | undefined) => value?.toISOString() ?? '-';
const execFileAsync = promisify(execFile);

export async function inspectWorkflowCursor(path: string, ref: string, cursor: unknown) {
  const latest = (await execFileAsync('git', ['-C', path, 'rev-parse', ref], { encoding: 'utf8' })).stdout.trim();
  const current = cursor && typeof cursor === 'object' && 'commit' in cursor && typeof cursor.commit === 'string'
    ? cursor.commit
    : undefined;
  if (!current) return { current, latest, rewritten: false, behind: undefined };
  try {
    await execFileAsync('git', ['-C', path, 'merge-base', '--is-ancestor', current, latest]);
    const behind = Number((await execFileAsync(
      'git', ['-C', path, 'rev-list', '--count', `${current}..${latest}`], { encoding: 'utf8' },
    )).stdout.trim());
    return { current, latest, rewritten: false, behind };
  } catch {
    return { current, latest, rewritten: true, behind: undefined };
  }
}

export const formatManualRunResult = (
  jobId: string,
  run: { status: string; summary?: string | null; error?: string | null } | null,
) => {
  if (run?.status === 'succeeded') return `✅ ${jobId} 手动执行完成：${run.summary ?? '无结果摘要'}`;
  if (run?.status === 'failed' || run?.status === 'timed_out') {
    return `❌ ${jobId} 手动执行${run.status === 'timed_out' ? '超时' : '失败'}：${run.error ?? run.summary ?? '未知错误'}`;
  }
  return `${jobId} 未执行（${run?.summary ?? '重复或未创建运行记录'}）。`;
};

export const explainWorkflowRun = (summary?: string | null) => {
  if (!summary) return '-';
  if (summary.includes('candidate=none')) return '未发现新的可执行工作流文档';
  if (summary.includes('gate=plan_review') && summary.includes('document_ready=true')) {
    return 'PLAN 已就绪，等待下一次 watcher 发送审批卡片';
  }
  if (summary.includes('gate=plan_review')) return '等待 PLAN 审批';
  if (summary.includes('gate=automation_disabled')) return '工作流自动化已关闭';
  if (summary.includes('result=session_started')) return '已启动新 Session';
  if (summary.includes('duplicate=true')) return '该工作流文档已经处理过';
  return summary;
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
  if (action !== 'list' && (!jobId || !['status', 'cursor', 'enable', 'disable', 'run', 'stop'].includes(action || ''))) {
    return '用法：/ap jobs | /ap job <status|cursor|enable|disable|run|stop> <job-id> [--latest]';
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
    const latestRun = await prisma.scheduledJobRun.findFirst({
      where: { projectId: project.id, jobId: job.id },
      orderBy: { startedAt: 'desc' },
      select: { status: true, trigger: true, summary: true },
    });
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
      `last status: ${latestRun?.status ?? '-'}`,
      `last trigger: ${latestRun?.trigger ?? '-'}`,
      `last result: ${latestRun?.summary ?? '-'}`,
      `reason: ${job.type === 'workflow_watcher' ? explainWorkflowRun(latestRun?.summary) : latestRun?.summary ?? '-'}`,
    ].join('\n');
  }
  if (action === 'cursor') {
    if (job.type !== 'workflow_watcher') return `${job.id} 不使用 workflow 游标。`;
    const cursor = await inspectWorkflowCursor(project.path, project.ref, state?.cursorJson);
    if (!command.options.latest) {
      return [
        `${project.name} / ${job.id}`,
        `cursor: ${cursor.current ?? '-'}`,
        `latest: ${cursor.latest}`,
        `history rewritten: ${cursor.rewritten}`,
        `behind: ${cursor.behind ?? '-'}`,
      ].join('\n');
    }
    if (!isFeishuAdmin(context.senderOpenId) && !project.feishu.approver_open_ids.includes(context.senderOpenId)) {
      return '只有平台管理员或项目审批人可以移动 job 游标。';
    }
    if (running.has(job.id)) return `${job.id} 正在运行，请先停止后再移动游标。`;
    await prisma.scheduledJobState.upsert({
      where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
      create: { projectId: project.id, jobId: job.id, cursorJson: { commit: cursor.latest } },
      update: { cursorJson: { commit: cursor.latest }, lastError: null },
    });
    return `✅ ${job.id} 游标已移动到 ${cursor.latest}；旧提交不会被执行。`;
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
    if (!enabled) {
      await stopScheduledJob(prisma, project.id, job.id);
      await waitForScheduledJobStop(prisma, project.id, job.id);
    }
    return `✅ ${job.id} 已${enabled ? '启用' : '停用'}。`;
  }
  if (action === 'stop') {
    const stopped = await stopScheduledJob(prisma, project.id, job.id);
    if (!stopped) return `${job.id} 当前没有可停止的执行。`;
    await waitForScheduledJobStop(prisma, project.id, job.id);
    return `✅ ${job.id} 当前执行已停止；启用状态未改变。`;
  }

  if (!jobHandlers.has(job.type)) return `job 类型未注册 handler：${job.type}`;
  const request = await prisma.scheduledJobRequest.create({
    data: { projectId: project.id, jobId: job.id },
  });
  const idempotencyKey = `manual:${project.id}:${job.id}:${request.id}`;
  const deadline = Date.now() + Number(job.config.timeout_ms ?? 60_000) + 20_000;
  while (Date.now() < deadline) {
    const run = await prisma.scheduledJobRun.findUnique({
      where: { idempotencyKey },
      select: { status: true, summary: true, error: true },
    });
    if (run && run.status !== 'running') return formatManualRunResult(job.id, run);
    const failed = await prisma.scheduledJobRequest.findUnique({
      where: { id: request.id },
      select: { status: true, error: true },
    });
    if (failed?.status === 'failed') return `❌ ${job.id} 启动失败：${failed.error ?? '未知错误'}`;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return `${job.id} 执行仍未结束，请用 /ap job status ${job.id} 查看。`;
}
