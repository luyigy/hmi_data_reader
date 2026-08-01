import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { prisma } from '../prisma';
import {
  findProjectByChatId,
  loadProjectsConfig,
  type JobConfig,
  type ProjectConfig,
} from './project-config';
import { resolveWorkflowAutonomy, type WorkflowAutonomy } from './workflow-autonomy';
import {
  formatWorkflowOverview,
  inspectWorkflowOverview,
  type WorkflowOverview,
} from './workflow-inspection';

const execFileAsync = promisify(execFile);

type JsonObject = Record<string, unknown>;

export type WorkflowStatus = {
  projectId: string;
  projectName: string;
  repository: string;
  ref: string;
  head: string;
  jobId: string;
  enabled: boolean;
  running: boolean;
  mode: string;
  autonomy: WorkflowAutonomy;
  autonomySource: 'config' | 'override' | 'safe_fallback';
  schedule: string;
  stage: string;
  documentPath: string;
  plan: string;
  slice: string;
  action: string;
  approval: string;
  session: string;
  validator: string;
  lastFinishedAt: string;
  lastSuccessAt: string;
  lastError: string;
  retry: string;
  nextStep: string;
  lastRun?: {
    status: string;
    summary: string;
    startedAt: string;
  };
  completion?: {
    commit: string;
    validation: string;
    entry: string;
    automaticProgression: string;
  };
  overview?: WorkflowOverview;
};

const object = (value: unknown): JsonObject | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;

const text = (value: unknown, fallback = '-') =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

const date = (value: Date | null | undefined) => value?.toISOString() ?? '-';

const summaryFields = (summary?: string | null) => {
  const fields: Record<string, string> = {};
  for (const match of Array.from(summary?.matchAll(/(?:^|\s)([a-z_]+)=([^\s]+)/g) ?? [])) {
    fields[match[1]] = match[2];
  }
  return fields;
};

const workflowContextValue = (context: unknown, label: string) => {
  if (typeof context !== 'string') return undefined;
  const match = context.match(new RegExp(`\\*\\*${label}\\*\\*：([^\\n]+)`));
  return match?.[1]?.trim();
};

export const extractWorkflowValidationSummary = (content: string) => {
  const section = content.match(/(?:^|\n)## 验证结果\s*\n([\s\S]*?)(?=\n## |\n<!--|$)/);
  if (!section) return '未在工作流文档中声明验证结果';
  const lines = section[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, ''));
  return lines.length ? lines.join('；') : '验证结果章节未列出检查项';
};

export const buildWorkflowCompletionReceipt = (args: {
  commit: string;
  documentPath: string;
  action: string;
  validation: string;
  plan?: string;
  slice?: string;
  automaticProgression?: string;
}) => {
  const outcome = args.action === 'next_slice'
    ? `Slice ${args.slice || '-'} 已完成`
    : args.action === 'resume_parent'
      ? 'Interrupt PLAN 已完成，将返回父 PLAN'
      : args.action === 'await_acceptance'
        ? 'PLAN 已完成，等待人工验收'
        : `Workflow 已完成（${args.action}）`;
  return [
    '✅ Workflow 完成回执',
    `结果：${outcome}`,
    `PLAN / Slice：${args.plan || '-'} / ${args.slice || '-'}`,
    `commit：${args.commit}`,
    `实际验证：${args.validation}`,
    `HANDOVER / 验收入口：${args.documentPath}`,
    `自动推进：${args.automaticProgression
      ?? (['next_slice', 'resume_parent', 'start_first_slice'].includes(args.action)
        ? `将按 ${args.action} 启动下一工作单元（Session 是否换代独立决定）`
        : `已停止（${args.action}，不启动新 Session）`)}`,
  ].join('\n');
};

const readCommittedDocument = async (
  project: ProjectConfig,
  head: string,
  documentPath: string,
) => {
  if (!documentPath || documentPath === '-' || documentPath.includes('..')) {
    return { metadata: {} as JsonObject, validation: '-' };
  }
  try {
    const content = (await execFileAsync(
      'git',
      ['-C', project.path, 'show', `${head}:${documentPath}`],
      { encoding: 'utf8' },
    )).stdout;
    const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
    return {
      metadata: object(frontmatter ? parse(frontmatter[1]) : null) ?? {},
      validation: extractWorkflowValidationSummary(content),
    };
  } catch {
    return { metadata: {} as JsonObject, validation: '-' };
  }
};

const nextStepFor = (args: {
  enabled: boolean;
  running: boolean;
  jobId: string;
  stage: string;
  documentPath: string;
  action: string;
}) => {
  if (!args.enabled) return `/ap job enable ${args.jobId}`;
  if (args.running) return '等待本轮执行结束，然后刷新 /ap workflow status';
  if (args.stage === '等待手动推进') return `/ap job run ${args.jobId}`;
  if (args.stage === '等待审批') return '在现有 PLAN 审批卡中批准或退回修改';
  if (args.stage === '等待修改意见') return `补充修改意见后执行 /ap job retry ${args.jobId}`;
  if (args.stage === '等待修改提交') return `完成并提交 ${args.documentPath} 的修订`;
  if (args.stage === '文档错误') return `修复并重新提交 ${args.documentPath}`;
  if (args.stage === '已隔离') return `修复 ${args.documentPath} 并提交新 blob，watcher 将自动复验`;
  if (args.stage === '运行阻塞') return `执行 /ap job diagnose ${args.jobId} 并按“建议动作”处理`;
  if (args.stage === '运行故障') return `修复运行环境后执行 /ap job run ${args.jobId}`;
  if (args.stage === '完成') {
    return ['next_slice', 'resume_parent', 'start_first_slice'].includes(args.action)
      ? '等待 watcher 自动启动下一工作单元'
      : '查看 HANDOVER / 验收入口并完成人工验收';
  }
  return '等待新的已提交 PLAN/HANDOVER，或刷新 /ap workflow status';
};

const buildWorkflowStatus = async (
  project: ProjectConfig,
  job: JobConfig,
): Promise<WorkflowStatus> => {
  const [state, latestRun, latestDispatch, binding, headResult] = await Promise.all([
    prisma.scheduledJobState.findUnique({
      where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
    }),
    prisma.scheduledJobRun.findFirst({
      where: { projectId: project.id, jobId: job.id },
      orderBy: { startedAt: 'desc' },
      select: {
        status: true,
        summary: true,
        error: true,
        startedAt: true,
        finishedAt: true,
      },
    }),
    prisma.workflowDispatch.findFirst({
      where: { projectId: project.id, jobId: job.id },
      orderBy: { updatedAt: 'desc' },
      select: { state: true, eventKey: true },
    }),
    prisma.feishuConversationBinding.findFirst({
      where: { chatId: String(job.config.coding_bot_chat_id || project.feishu.chat_id) },
      orderBy: { updatedAt: 'desc' },
      select: {
        liveRoom: {
          select: {
            sourceTask: {
              select: {
                currentTaskSession: {
                  select: { id: true, status: true, attentionState: true, activeRunId: true },
                },
              },
            },
          },
        },
      },
    }),
    execFileAsync('git', ['-C', project.path, 'rev-parse', project.ref], { encoding: 'utf8' }),
  ]);
  const head = headResult.stdout.trim();
  const cursor = object(state?.cursorJson);
  const pending = object(cursor?.pending);
  const validationFailure = object(cursor?.validationFailure);
  const blocker = object(cursor?.blocker);
  const fields = summaryFields(latestRun?.summary);
  const documentPath = text(pending?.path ?? fields.candidate);
  const committedDocument = await readCommittedDocument(project, head, documentPath);
  const action = text(pending?.action ?? committedDocument.metadata.next_action ?? fields.action);
  const plan = text(
    committedDocument.metadata.plan
      ?? workflowContextValue(pending?.workflowContext, '关联 PLAN'),
  );
  const slice = text(
    committedDocument.metadata.slice
      ?? workflowContextValue(pending?.workflowContext, '当前或将执行的 Slice'),
  );
  const reviewState = text(pending?.reviewState, '');
  const autonomy = resolveWorkflowAutonomy(job, state?.workflowAutonomy);
  const enabled = state?.enabledOverride ?? job.enabled;
  const running = latestRun?.status === 'running';
  const quarantined = validationFailure?.quarantined === true;
  const terminalComplete = latestRun?.status === 'succeeded'
    && ['notified', 'session_started'].includes(fields.result)
    && /_HANDOVER_/.test(documentPath)
    && documentPath !== '-';
  const stage = !enabled
    ? '已停用'
    : running
      ? '正在执行'
      : blocker
        ? '运行阻塞'
        : quarantined
          ? '已隔离'
          : validationFailure
            ? '文档错误'
            : reviewState === 'review'
              ? '等待审批'
              : reviewState === 'awaiting_revision_feedback'
                ? '等待修改意见'
                : ['revision', 'revision_requested'].includes(reviewState)
                  ? '等待修改提交'
                  : fields.gate === 'autonomy_manual'
                    ? '等待手动推进'
                    : terminalComplete
                      ? '完成'
                      : latestRun && ['failed', 'timed_out'].includes(latestRun.status)
                        ? '运行故障'
                        : '空闲';
  const taskSession = binding?.liveRoom.sourceTask?.currentTaskSession;
  const validator = validationFailure
    ? `document_invalid：${text(validationFailure.error)}`
    : blocker || (latestRun && ['failed', 'timed_out'].includes(latestRun.status))
      ? `runtime_unavailable：${text(blocker?.error ?? latestRun?.error ?? state?.lastError)}`
      : latestRun?.status === 'succeeded'
        ? 'valid：最近一轮 watcher 已成功完成'
        : 'unknown：尚无可判定的 watcher 结果';
  const retry = quarantined
    ? 'quarantined：旧 blob 已跳过，新 blob 会重新校验'
    : validationFailure
      ? 'retry_pending：同一 blob 再失败将隔离'
      : reviewState
        ? `approval_${reviewState}`
        : latestRun && ['failed', 'timed_out'].includes(latestRun.status)
          ? 'runtime_retry_available'
          : 'none';
  const nextStep = nextStepFor({ enabled, running, jobId: job.id, stage, documentPath, action });
  const status: WorkflowStatus = {
    projectId: project.id,
    projectName: project.name,
    repository: project.path,
    ref: project.ref,
    head,
    jobId: job.id,
    enabled,
    running,
    mode: state?.modeOverride ?? job.mode,
    autonomy: autonomy.mode,
    autonomySource: autonomy.source,
    schedule: state?.scheduleOverride ?? job.schedule,
    stage,
    documentPath,
    plan,
    slice,
    action,
    approval: reviewState || 'none',
    session: taskSession
      ? `${taskSession.id} · ${taskSession.status} · ${taskSession.attentionState} · run ${taskSession.activeRunId ?? '-'}`
      : latestDispatch
        ? `dispatch ${latestDispatch.state} · ${latestDispatch.eventKey}`
        : 'none',
    validator,
    lastFinishedAt: date(state?.lastFinishedAt),
    lastSuccessAt: date(state?.lastSuccessAt),
    lastError: text(state?.lastError ?? latestRun?.error),
    retry,
    nextStep,
    ...(latestRun ? {
      lastRun: {
        status: latestRun.status,
        summary: text(latestRun.summary),
        startedAt: latestRun.startedAt.toISOString(),
      },
    } : {}),
  };
  if (terminalComplete) {
    status.completion = {
      commit: text(fields.commit, head),
      validation: committedDocument.validation,
      entry: documentPath,
      automaticProgression: ['next_slice', 'resume_parent', 'start_first_slice'].includes(action)
        ? `pending：${action}`
        : `stopped：${action}`,
    };
  }
  status.overview = await inspectWorkflowOverview(project.path, head, state?.cursorJson, job.config, status)
    .catch((error) => ({
      queue: [],
      plans: [],
      warnings: [`计划清单读取失败：${error instanceof Error ? error.message : String(error)}`],
    }));
  return status;
};

export const loadWorkflowStatuses = async (projectId?: string) => {
  const config = await loadProjectsConfig();
  const projects = projectId
    ? config.projects.filter((project) => project.id === projectId)
    : config.projects;
  return Promise.all(projects.flatMap((project) =>
    project.jobs
      .filter((job) => job.type === 'workflow_watcher')
      .map((job) => buildWorkflowStatus(project, job))));
};

export const loadWorkflowStatusForChat = async (chatId: string) => {
  const config = await loadProjectsConfig();
  const project = findProjectByChatId(config, chatId);
  if (!project) return null;
  return (await loadWorkflowStatuses(project.id))[0] ?? null;
};

export const formatWorkflowStatus = (status: WorkflowStatus) => [
  `${status.projectName} / ${status.jobId}`,
  `项目 / ref / HEAD：${status.projectId} · ${status.ref} · ${status.head}`,
  `阶段：${status.stage}`,
  `自治模式：${status.autonomy}（${status.autonomySource}）`,
  `PLAN / Slice / 动作：${status.plan} · ${status.slice} · ${status.action}`,
  `工作流文档：${status.documentPath}`,
  `审批：${status.approval}`,
  `Session：${status.session}`,
  `Validator：${status.validator}`,
  `最近成功：${status.lastSuccessAt}`,
  `最近完成：${status.lastFinishedAt}`,
  `最近错误：${status.lastError}`,
  `重试 / 隔离：${status.retry}`,
  ...(status.completion ? [
    '完成回执：',
    `- commit：${status.completion.commit}`,
    `- 实际验证：${status.completion.validation}`,
    `- HANDOVER / 验收入口：${status.completion.entry}`,
    `- 自动推进：${status.completion.automaticProgression}`,
  ] : []),
  ...(status.overview ? ['', formatWorkflowOverview(status.overview)] : []),
  `唯一下一步：${status.nextStep}`,
].join('\n');
