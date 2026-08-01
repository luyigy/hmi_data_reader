import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { isFeishuAdmin } from '@/lib/feishu-access-approval';
import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import type { FeishuConversationContext } from '@/lib/feishu-live-room';
import { jobHandlers } from '@/lib/scheduled-jobs/handlers';
import { findProjectByChatId, loadProjectsConfig, validateSchedule } from '@/lib/scheduled-jobs/project-config';
import { effectiveJobSchedule, stopScheduledJob, waitForScheduledJobStop } from '@/lib/scheduled-jobs/runner';
import {
  formatWorkflowStatus,
  loadWorkflowStatuses,
  type WorkflowStatus,
} from '@/lib/scheduled-jobs/workflow-status';
import { getPersistedHarnessPid } from '@/lib/live-room-interrupt';
import { sendFeishuInteractiveMessage, sendFeishuTextMessage } from '@/lib/feishu-api';
import { handleWorkflowPolicyCommand } from '@/lib/feishu-workflow-policy';
import {
  formatWorkflowOverview,
  inspectWorkflowCandidates,
  inspectWorkflowCursor,
} from '@/lib/scheduled-jobs/workflow-inspection';

const date = (value: Date | null | undefined) => value?.toISOString() ?? '-';
export { inspectWorkflowCandidates, inspectWorkflowCursor } from '@/lib/scheduled-jobs/workflow-inspection';

export const formatWorkflowDiagnosis = ({
  projectName,
  jobId,
  enabled,
  running,
  mode,
  schedule,
  cursor,
  pending,
  candidates,
  lastError,
  recentFailure,
}: {
  projectName: string;
  jobId: string;
  enabled: boolean;
  running: boolean;
  mode: string;
  schedule: string;
  cursor: Awaited<ReturnType<typeof inspectWorkflowCursor>>;
  pending: unknown;
  candidates: string[];
  lastError?: string | null;
  recentFailure?: { status: string; error?: string | null; summary?: string | null } | null;
}) => [
  `${projectName} / ${jobId} 诊断（只读）`,
  `已启用：${enabled ? '是' : '否'}`,
  `运行中：${running ? '是' : '否'}`,
  `模式：${mode}`,
  `调度：${schedule}`,
  `游标：${cursor.current ?? '-'}`,
  `最新提交：${cursor.latest}`,
  `游标属于当前历史：${cursor.current ? !cursor.rewritten ? '是' : '否' : '-'}`,
  `落后提交数：${cursor.behind ?? '-'}`,
  ...formatWorkflowPending(pending),
  `最近错误：${lastError ?? '-'}`,
  `最近失败：${recentFailure ? `${recentFailure.status}: ${recentFailure.error ?? recentFailure.summary ?? '-'}` : '-'}`,
  `候选工作流文档：${candidates.length ? candidates.join(', ') : '无'}`,
  cursor.rewritten
    ? '安全提示: 历史已改写；--latest 会跳过待处理提交，需人工确认恢复基准。'
    : '安全提示: 本命令只读；不会写数据库、移动 cursor、清除 pending、发送飞书消息或启动 Agent。',
].join('\n');

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
  if (summary.includes('gate=plan_review') && summary.includes('card_sent=true')) {
    return 'PLAN 审批卡已发送，等待审批';
  }
  if (summary.includes('gate=plan_review') && summary.includes('document_ready=true')) {
    return 'PLAN 已就绪，等待下一次 watcher 发送审批卡片';
  }
  if (summary.includes('gate=plan_review')) return '等待 PLAN 审批';
  if (summary.includes('gate=automation_disabled')) return '工作流自动化已关闭';
  if (summary.includes('result=session_started')) return '已启动新 Session';
  if (summary.includes('duplicate=true')) return '该工作流文档已经处理过';
  return summary;
};

export const formatWorkflowPending = (cursor: unknown) => {
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !('pending' in cursor)) {
    return ['待处理文档：无'];
  }
  const pending = cursor.pending;
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) {
    return ['待处理文档：无'];
  }
  const value = pending as Record<string, unknown>;
  const reviewState = String(value.reviewState || 'preparing');
  return [
    `待处理文档：${String(value.path || '-')}`,
    `等待节点：${String(value.gate || '-')}`,
    `待执行动作：${String(value.action || '-')}`,
    `评审状态：${reviewState}`,
    ...(reviewState === 'review'
      ? [
        `评审截止：${String(value.reviewExpiresAt || '-')}`,
        `评审消息：${String(value.reviewMessageId || '-')}`,
      ]
      : ['revision', 'revision_requested'].includes(reviewState)
        ? [`修改任务已投递：${value.revisionDispatched === true ? '是' : '否'}`]
        : []),
  ];
};

export const buildWorkflowRetryPending = (
  pending: Record<string, unknown>,
  requestId: string,
) => {
  const next: Record<string, unknown> = { ...pending, revisionDispatched: false };
  delete next.revisionFeedbackMessageId;
  delete next.revisionDispatchKey;
  if (typeof pending.reviewFeedback !== 'string' || !pending.reviewFeedback.trim()) {
    return { ...next, reviewState: 'awaiting_revision_feedback', reviewFeedback: '' };
  }
  return {
    ...next,
    revisionDispatchKey: `${String(pending.key)}:retry:${requestId}`,
  };
};

export const buildWorkflowResendPending = (pending: Record<string, unknown>) => (
  pending.reviewState === 'review'
    ? { ...pending, reviewExpiresAt: new Date(0).toISOString() }
    : null
);

const pendingValue = (cursor: unknown) => {
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !('pending' in cursor)) return null;
  const pending = cursor.pending;
  return pending && typeof pending === 'object' && !Array.isArray(pending)
    ? pending as Record<string, unknown>
    : null;
};

export const buildWorkflowDashboardCard = (args: {
  status: WorkflowStatus;
  cursor: Awaited<ReturnType<typeof inspectWorkflowCursor>>;
  pending: Record<string, unknown> | null;
}) => {
  const reviewState = String(args.pending?.reviewState || '');
  const stage = !args.status.enabled
    ? '⏸️ 已停用'
    : args.status.running
      ? '🔄 正在执行'
      : reviewState === 'review'
        ? '🟠 等待 PLAN 审批'
        : reviewState === 'awaiting_revision_feedback'
          ? '🟠 等待填写修改意见'
          : ['revision_requested', 'revision'].includes(reviewState)
            ? `🔵 ${args.pending?.revisionDispatched ? '修改任务已投递，等待 PLAN 提交' : '修改任务待恢复'}`
            : args.pending
              ? `🟡 ${String(args.pending.gate || '处理中')}`
              : `🟢 ${args.status.stage}`;
  const action = (label: string, actionName: string, type = 'default') => ({
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    ...(type === 'danger' ? {
      confirm: {
        title: { tag: 'plain_text', content: `确认${label}` },
        text: { tag: 'plain_text', content: `确定要${label} ${args.status.jobId} 吗？` },
      },
    } : {}),
    value: {
      cmd: 'workflow-dashboard',
      action: actionName,
      projectId: args.status.projectId,
      jobId: args.status.jobId,
      expectedHead: args.status.head,
    },
  });
  const actions = [
    action('刷新', 'refresh'),
    ...(!args.status.running && args.status.enabled ? [action('立即运行', 'run')] : []),
    ...(reviewState === 'review' ? [action('重发审批卡', 'resend', 'primary')] : []),
    ...(['revision', 'awaiting_revision_feedback'].includes(reviewState)
      ? [action('恢复修改任务', 'retry', 'primary')]
      : []),
    ...(args.status.running ? [action('停止', 'stop', 'danger')] : []),
    action(
      args.status.enabled ? '停用' : '启用',
      args.status.enabled ? 'disable' : 'enable',
      args.status.enabled ? 'danger' : 'primary',
    ),
    action('Manual', 'autonomy_manual', args.status.autonomy === 'manual' ? 'primary' : 'default'),
    action('Semi-auto', 'autonomy_semi_auto', args.status.autonomy === 'semi_auto' ? 'primary' : 'default'),
    action('Auto', 'autonomy_auto', args.status.autonomy === 'auto' ? 'primary' : 'default'),
    action('校验状态', 'validation_show'),
    action('错误模板', 'validation_template'),
    action('Balanced', 'validation_balanced'),
    action('Strict', 'validation_strict'),
    ...(args.status.stage === '文档错误' || args.status.stage === '已隔离'
      ? [action('受控修复', 'validation_repair', 'primary')]
      : []),
  ];
  return {
    config: { wide_screen_mode: true },
    header: {
      template: args.status.lastError !== '-' ? 'red'
        : args.status.running ? 'blue' : args.status.enabled ? 'green' : 'grey',
      title: { tag: 'plain_text', content: 'Workflow Dashboard' },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**${args.status.projectName} / ${args.status.jobId}**`,
          `**状态**：${stage}`,
          `**项目 / ref / HEAD**：${args.status.projectId} · \`${args.status.ref}\` · \`${args.status.head.slice(0, 8)}\``,
          `**自治模式**：${args.status.autonomy}（${args.status.autonomySource}）`,
          `**PLAN / Slice / 动作**：${args.status.plan} · ${args.status.slice} · ${args.status.action}`,
          `**模式 / 调度**：${args.status.mode} · \`${args.status.schedule}\``,
          `**审批 / Session**：${args.status.approval} · ${args.status.session}`,
          `**Validator**：${args.status.validator}`,
          `**游标**：\`${args.cursor.current?.slice(0, 8) || '-'}\` → \`${args.cursor.latest.slice(0, 8)}\`（behind ${args.cursor.behind ?? '-'}）`,
          `**最近成功 / 错误**：${args.status.lastSuccessAt} · ${args.status.lastError}`,
          `**重试 / 隔离**：${args.status.retry}`,
          ...(args.status.completion ? [
            `**完成回执**：commit \`${args.status.completion.commit}\` · 验证 ${args.status.completion.validation} · 入口 ${args.status.completion.entry} · 自动推进 ${args.status.completion.automaticProgression}`,
          ] : []),
          ...(args.status.overview ? ['', formatWorkflowOverview(args.status.overview)] : []),
          `**唯一下一步**：${args.status.nextStep}`,
        ].join('\n'),
      },
      { tag: 'action', actions },
      {
        tag: 'note',
        elements: [{
          tag: 'plain_text',
          content: '重发审批卡只适用于等待审批；退回修改后请点“恢复修改任务”。清除 pending / 移动 cursor 仍需显式命令。',
        }],
      },
    ],
  };
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
  if (action !== 'list' && (!jobId || !['status', 'dashboard', 'cursor', 'diagnose', 'schedule', 'enable', 'disable', 'run', 'retry', 'resend', 'stop'].includes(action || ''))) {
    return '用法：/ap jobs | /ap dashboard | /ap job <status|dashboard|cursor|diagnose|schedule|enable|disable|run|retry|resend|stop> <job-id>';
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
      return `${job.id}：${state?.enabledOverride ?? job.enabled ? '已启用' : '已停用'} · ${running.has(job.id) ? '运行中' : '空闲'} · 模式 ${state?.modeOverride ?? job.mode} · 调度 ${effectiveJobSchedule(job, state)}`;
    }).join('\n');
  }

  const job = project.jobs.find((candidate) => candidate.id === jobId);
  if (!job) return `未注册 job：${jobId}`;
  const state = stateByJob.get(job.id);
  if (action === 'dashboard') {
    if (job.type !== 'workflow_watcher') return `${job.id} 不支持 workflow dashboard。`;
    const [cursor, workflowStatus] = await Promise.all([
      inspectWorkflowCursor(project.path, project.ref, state?.cursorJson),
      loadWorkflowStatuses(project.id).then((items) => items.find((item) => item.jobId === job.id)),
    ]);
    if (!workflowStatus) return `${job.id} Workflow 状态不可用。`;
    await sendFeishuInteractiveMessage({
      receiveId: context.chatId,
      receiveIdType: 'chat_id',
      replyId: context.messageId,
      card: buildWorkflowDashboardCard({
        status: workflowStatus,
        cursor,
        pending: pendingValue(state?.cursorJson),
      }),
    });
    return '✅ Workflow Dashboard 已发送。';
  }
  if (action === 'status') {
    if (job.type === 'workflow_watcher') {
      const workflowStatus = (await loadWorkflowStatuses(project.id))
        .find((item) => item.jobId === job.id);
      if (workflowStatus) return formatWorkflowStatus(workflowStatus);
    }
    const latestRun = await prisma.scheduledJobRun.findFirst({
      where: { projectId: project.id, jobId: job.id },
      orderBy: { startedAt: 'desc' },
      select: { status: true, trigger: true, summary: true },
    });
    return [
      `${project.name} / ${job.id}`,
      `仓库：${project.path}`,
      `Git ref：${project.ref}`,
      `调度：${effectiveJobSchedule(job, state)}`,
      `已启用：${state?.enabledOverride ?? job.enabled ? '是' : '否'}`,
      `运行中：${running.has(job.id) ? '是' : '否'}`,
      `模式：${state?.modeOverride ?? job.mode}`,
      `最近执行：${date(state?.lastFinishedAt)}`,
      `最近成功：${date(state?.lastSuccessAt)}`,
      `最近错误：${state?.lastError ?? '-'}`,
      `最近状态：${latestRun?.status ?? '-'}`,
      `触发方式：${latestRun?.trigger ?? '-'}`,
      `原始结果：${latestRun?.summary ?? '-'}`,
      `说明：${job.type === 'workflow_watcher' ? explainWorkflowRun(latestRun?.summary) : latestRun?.summary ?? '-'}`,
    ].join('\n');
  }
  if (action === 'cursor') {
    if (job.type !== 'workflow_watcher') return `${job.id} 不使用 workflow 游标。`;
    const cursor = await inspectWorkflowCursor(project.path, project.ref, state?.cursorJson);
    const clearPending = command.options['clear-pending'] === 'true';
    if (!command.options.latest && !clearPending) {
      return [
        `${project.name} / ${job.id}`,
        `游标：${cursor.current ?? '-'}`,
        `最新提交：${cursor.latest}`,
        `历史已改写：${cursor.rewritten ? '是' : '否'}`,
        `落后提交数：${cursor.behind ?? '-'}`,
        ...formatWorkflowPending(state?.cursorJson),
      ].join('\n');
    }
    if (command.options.latest && clearPending) {
      return '--latest 和 --clear-pending 不能同时使用。';
    }
    if (!isFeishuAdmin(context.senderOpenId) && !project.feishu.approver_open_ids.includes(context.senderOpenId)) {
      return '只有平台管理员或项目审批人可以移动 job 游标。';
    }
    if (running.has(job.id)) return `${job.id} 正在运行，请先停止后再移动游标。`;
    if (clearPending) {
      const current = state?.cursorJson;
      if (!current || typeof current !== 'object' || Array.isArray(current) || !('pending' in current)) {
        return `${job.id} 当前没有 pending。`;
      }
      const nextCursor = { ...current };
      delete nextCursor.pending;
      await prisma.scheduledJobState.update({
        where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
        data: { cursorJson: nextCursor as Prisma.InputJsonValue, lastError: null },
      });
      return `✅ ${job.id} pending 已清除；游标仍为 ${String(nextCursor.commit ?? '-')}。`;
    }
    await prisma.scheduledJobState.upsert({
      where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
      create: { projectId: project.id, jobId: job.id, cursorJson: { commit: cursor.latest } },
      update: { cursorJson: { commit: cursor.latest }, lastError: null },
    });
    return `✅ ${job.id} 游标已移动到 ${cursor.latest}；旧提交不会被执行。`;
  }
  if (action === 'diagnose') {
    if (job.type !== 'workflow_watcher') return `${job.id} 不支持 workflow 诊断。`;
    const cursor = await inspectWorkflowCursor(project.path, project.ref, state?.cursorJson);
    const recentFailure = await prisma.scheduledJobRun.findFirst({
      where: { projectId: project.id, jobId: job.id, status: { in: ['failed', 'timed_out'] } },
      orderBy: { startedAt: 'desc' },
      select: { status: true, error: true, summary: true },
    });
    let candidates: string[] = [];
    let diagnosticError: string | null = null;
    if (!cursor.rewritten) {
      try {
        candidates = await inspectWorkflowCandidates(project.path, cursor.latest, state?.cursorJson, job.config);
      } catch (error) {
        diagnosticError = error instanceof Error ? error.message : String(error);
      }
    }
    const output = formatWorkflowDiagnosis({
      projectName: project.name,
      jobId: job.id,
      enabled: state?.enabledOverride ?? job.enabled,
      running: running.has(job.id),
      mode: state?.modeOverride ?? job.mode,
      schedule: effectiveJobSchedule(job, state),
      cursor,
      pending: state?.cursorJson,
      candidates,
      lastError: state?.lastError,
      recentFailure,
    });
    return diagnosticError ? `${output}\ndiagnostic error: ${diagnosticError}` : output;
  }

  if (!isFeishuAdmin(context.senderOpenId) && !project.feishu.approver_open_ids.includes(context.senderOpenId)) {
    return '只有平台管理员或项目审批人可以启停或运行 job。';
  }

  if (action === 'schedule') {
    const input = (command.options.cron || command.args.slice(2).join(' ')).trim();
    if (!input) return '用法：/ap job schedule <job-id> --cron="* * * * *"；使用 --cron=default 恢复项目配置。';
    let scheduleOverride: string | null;
    try {
      scheduleOverride = input === 'default' ? null : validateSchedule(input, 'schedule');
    } catch (error) {
      return `无效调度表达式：${error instanceof Error ? error.message : String(error)}`;
    }
    await prisma.scheduledJobState.upsert({
      where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
      create: { projectId: project.id, jobId: job.id, scheduleOverride },
      update: { scheduleOverride },
    });
    return `✅ ${job.id} 调度周期已设置为 ${scheduleOverride ?? job.schedule}。`;
  }

  if (action === 'enable' || action === 'disable') {
    const enabled = action === 'enable';
    if (!enabled) await stopScheduledJob(prisma, project.id, job.id);
    await prisma.scheduledJobState.upsert({
      where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
      create: { projectId: project.id, jobId: job.id, enabledOverride: enabled },
      update: { enabledOverride: enabled },
    });
    if (!enabled) {
      await waitForScheduledJobStop(prisma, project.id, job.id);
    }
    return enabled
      ? `✅ ${job.id} 已启用。`
      : `✅ ${job.id} 已停用；后续调度和未开始请求将跳过。已投递的 Agent 不会自动终止，请用 /ap sessions 和 /ap stop --all 查看和停止。`;
  }
  if (action === 'stop') {
    const stopped = await stopScheduledJob(prisma, project.id, job.id);
    if (!stopped) return `${job.id} 当前没有可停止的执行。`;
    await waitForScheduledJobStop(prisma, project.id, job.id);
    return `✅ ${job.id} 当前执行已停止；启用状态未改变。`;
  }

  if (!jobHandlers.has(job.type)) return `job 类型未注册 handler：${job.type}`;
  let request;
  if (action === 'retry') {
    if (job.type !== 'workflow_watcher') return `${job.id} 不支持 workflow retry。`;
    if (!(state?.enabledOverride ?? job.enabled)) return `${job.id} 当前已停用，请先启用。`;
    if (running.has(job.id)) return `${job.id} 正在运行，请等待当前执行结束。`;
    const cursor = state?.cursorJson;
    const pending = pendingValue(cursor);
    if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return `${job.id} 当前没有 pending。`;
    if (!('reviewState' in pending)
      || !['revision', 'awaiting_revision_feedback'].includes(String(pending.reviewState))) {
      return `${job.id} 当前 pending 不是可重试的 revision/feedback 状态。`;
    }

    const codingBotChatId = String(job.config.coding_bot_chat_id || '');
    const binding = await prisma.feishuConversationBinding.findFirst({
      where: { chatId: codingBotChatId },
      orderBy: { updatedAt: 'desc' },
      select: { liveRoom: { select: { sourceTaskId: true } } },
    });
    if (!binding?.liveRoom.sourceTaskId) {
      return '❌ 无法确认 Coding Agent 绑定的 task，拒绝不安全的重复投递。';
    }
    const participants = await prisma.taskRunParticipant.findMany({
      where: {
        executionBackend: 'platform_local',
        controlMetadata: { not: null },
        taskRun: { taskId: binding.liveRoom.sourceTaskId },
      },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
    const active = (await Promise.all(participants.map((participant) =>
      getPersistedHarnessPid(participant.controlMetadata, participant.harnessType))))
      .filter((pid) => pid !== null);
    if (active.length) {
      return `❌ 检测到 ${active.length} 个实际存活的 Agent 进程，拒绝重复投递。请先用 /ap sessions 查看。`;
    }

    request = await prisma.$transaction(async (tx) => {
      const created = await tx.scheduledJobRequest.create({
        data: { projectId: project.id, jobId: job.id },
      });
      const nextCursor = {
        ...(cursor as Record<string, unknown>),
        pending: buildWorkflowRetryPending(pending as Record<string, unknown>, created.id),
      };
      await tx.scheduledJobState.update({
        where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
        data: { cursorJson: nextCursor as Prisma.InputJsonValue, lastError: null },
      });
      return created;
    });
  } else if (action === 'resend') {
    if (job.type !== 'workflow_watcher') return `${job.id} 不支持审批卡重发。`;
    if (!(state?.enabledOverride ?? job.enabled)) return `${job.id} 当前已停用，请先启用。`;
    if (running.has(job.id)) return `${job.id} 正在运行，请等待当前执行结束。`;
    const cursor = state?.cursorJson;
    const pending = pendingValue(cursor);
    if (!pending || !buildWorkflowResendPending(pending)) {
      return `${job.id} 当前不是等待审批状态；退回修改后请使用 /ap job retry ${job.id}。`;
    }
    request = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${project.id}:${job.id}`}, 0))::text
      `;
      const lockedState = await tx.scheduledJobState.findUnique({
        where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
        select: { cursorJson: true },
      });
      const lockedCursor = lockedState?.cursorJson;
      const resendPending = buildWorkflowResendPending(pendingValue(lockedCursor) || {});
      if (!lockedCursor || typeof lockedCursor !== 'object' || Array.isArray(lockedCursor) || !resendPending) {
        return null;
      }
      const created = await tx.scheduledJobRequest.create({
        data: { projectId: project.id, jobId: job.id },
      });
      await tx.scheduledJobState.update({
        where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
        data: {
          cursorJson: {
            ...(lockedCursor as Record<string, unknown>),
            pending: resendPending,
          } as Prisma.InputJsonValue,
          lastError: null,
        },
      });
      return created;
    });
    if (!request) return `${job.id} 审批状态已变化，请刷新 Dashboard。`;
  } else {
    request = await prisma.scheduledJobRequest.create({
      data: { projectId: project.id, jobId: job.id },
    });
  }
  if (command.options['no-wait'] === 'true') return `✅ ${job.id} 操作已提交。`;
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

export async function handleWorkflowDashboardCardAction(args: {
  projectId: string;
  jobId: string;
  action: string;
  actorOpenId?: string;
  cardMessageId?: string;
  expectedHead?: string;
}) {
  const config = await loadProjectsConfig();
  const project = config.projects.find(({ id }) => id === args.projectId);
  if (!project || !project.jobs.some(({ id }) => id === args.jobId)) return 'Dashboard 已失效，请重新发送 /ap dashboard。';
  if (!args.actorOpenId) return '无法识别操作人。';
  const action = [
    'refresh', 'run', 'retry', 'resend', 'stop', 'enable', 'disable',
    'autonomy_manual', 'autonomy_semi_auto', 'autonomy_auto',
    'validation_show', 'validation_template', 'validation_balanced', 'validation_strict', 'validation_repair',
  ].includes(args.action)
    ? args.action
    : 'refresh';
  const context: FeishuConversationContext = {
    chatId: project.feishu.chat_id,
    chatType: 'group',
    senderOpenId: args.actorOpenId,
    messageId: args.cardMessageId || '',
  };
  const result = action === 'refresh'
    ? '状态已刷新。'
    : action.startsWith('validation_')
      ? await handleWorkflowPolicyCommand({
        command: 'workflow',
        args: action === 'validation_show'
          ? ['validation', 'show']
          : action === 'validation_template'
            ? ['validation', 'template']
            : action === 'validation_repair'
              ? ['validation', 'repair']
              : ['validation', 'set', action.slice('validation_'.length)],
        options: ['validation_show', 'validation_template'].includes(action)
          ? {}
          : { head: args.expectedHead || '' },
      }, context)
    : action.startsWith('autonomy_')
      ? args.expectedHead
        ? await handleWorkflowPolicyCommand({
          command: 'workflow',
          args: ['autonomy', 'set', action.slice('autonomy_'.length)],
          options: { head: args.expectedHead },
        }, context)
        : 'Dashboard 已失效，请重新发送 /ap dashboard。'
      : await handleScheduledJobCommand({
        command: 'job',
        args: [action, args.jobId],
        options: {},
      }, context);
  await sendFeishuTextMessage({
    receiveId: context.chatId,
    receiveIdType: 'chat_id',
    replyId: args.cardMessageId,
    text: `Workflow Dashboard 操作结果：${result}`,
  });
  await handleScheduledJobCommand({
    command: 'job',
    args: ['dashboard', args.jobId],
    options: {},
  }, context);
  return result;
}
