import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseDocument } from 'yaml';
import { isFeishuAdmin } from '@/lib/feishu-access-approval';
import type { ParsedFeishuCommand } from '@/lib/feishu-command-parser';
import type { FeishuConversationContext } from '@/lib/feishu-live-room';
import { runWorkflowInBoundLiveRoom } from '@/lib/feishu-workflow';
import { prisma } from '@/lib/prisma';
import {
  findProjectByChatId,
  loadProjectsConfig,
  type JobConfig,
  type ProjectConfig,
  type ProjectsConfig,
} from '@/lib/scheduled-jobs/project-config';
import {
  readWorkflowContract,
  validateWorkflowDocuments,
  WorkflowDocumentValidationError,
  type WorkflowValidationIssue,
} from '@/lib/scheduled-jobs/workflow-validator';
import { validateWorkflowExecutionPolicy } from '@/lib/workflow-execution-policy';

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execFileAsync(
  'git', ['-C', cwd, ...args], { encoding: 'utf8' },
)).stdout.trim();

type ValidationMode = 'balanced' | 'strict';
type ValidationFailure = { path: string; blob: string } | null;

export const workflowValidationRepairKey = (failure: NonNullable<ValidationFailure>) =>
  `validation-repair:${failure.path}:${failure.blob}`;

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const failureFrom = (cursor: unknown): ValidationFailure => {
  const failure = object(object(cursor)?.validationFailure);
  return typeof failure?.path === 'string' && typeof failure.blob === 'string'
    ? { path: failure.path, blob: failure.blob }
    : null;
};

export const canManageWorkflowValidation = (
  senderOpenId: string,
  admin: boolean,
  approvers: string[],
) => admin || approvers.includes(senderOpenId);

const contractPathFor = (job: JobConfig) => String(
  job.config.contract_path || 'docs/workflow/workflow-contract.yaml',
);

const assertSingleConsumer = (config: ProjectsConfig, project: ProjectConfig, job: JobConfig) => {
  const contractPath = contractPathFor(job);
  const consumers = config.projects.flatMap((candidate) => candidate.jobs.filter((candidateJob) =>
    candidateJob.type === 'workflow_watcher'
    && candidate.path === project.path
    && candidate.ref === project.ref
    && contractPathFor(candidateJob) === contractPath));
  if (consumers.length !== 1) throw new Error('目标合同存在多个 workflow consumer，拒绝修改。');
};

const inspectIssues = async (
  project: ProjectConfig,
  job: JobConfig,
  head: string,
  failure: ValidationFailure,
) => {
  if (!failure) return [];
  try {
    const [result] = await validateWorkflowDocuments({
      cwd: project.path,
      ref: head,
      filePaths: [failure.path],
      contractPath: contractPathFor(job),
    });
    return result.issues;
  } catch (error) {
    if (error instanceof WorkflowDocumentValidationError) return error.issues;
    throw error;
  }
};

const formatIssue = (issue: WorkflowValidationIssue) =>
  `[${issue.severity} ${issue.code}] ${issue.location}：${issue.message}`;

export const inspectWorkflowValidation = async (
  project: ProjectConfig,
  job: JobConfig,
  cursor: unknown,
) => {
  const head = await git(project.path, 'rev-parse', project.ref);
  const contract = await readWorkflowContract(
    project.path,
    head,
    contractPathFor(job),
    new AbortController().signal,
  );
  const failure = failureFrom(cursor);
  const issues = await inspectIssues(project, job, head, failure);
  return { head, contract, failure, issues };
};

export const formatWorkflowValidationStatus = (inspection: Awaited<ReturnType<typeof inspectWorkflowValidation>>) => {
  const errors = inspection.issues.filter(({ severity }) => severity === 'error');
  const warnings = inspection.issues.filter(({ severity }) => severity === 'warning');
  const rules = Object.entries(inspection.contract.validation?.rules ?? {});
  return [
    `Workflow 校验：${inspection.contract.validation?.mode ?? 'strict'}`,
    `HEAD：${inspection.head}`,
    'Hard gate：始终启用（合同/YAML、动作、引用、Prompt、目标 HEAD、append-only、长文件）',
    `策略规则：${rules.length ? rules.map(([name, enabled]) => `${name}=${enabled ? 'on' : 'off'}`).join('、') : '未配置'}`,
    `最后失败文档：${inspection.failure?.path ?? '-'}`,
    `诊断：error ${errors.length} / warning ${warnings.length}`,
    ...inspection.issues.map(formatIssue),
    `唯一下一步：${errors.length
      ? `/ap workflow validation template，然后 /ap workflow validation repair --head=${inspection.head}`
      : '无需修复；等待或运行 workflow watcher'}`,
  ].join('\n');
};

export const formatWorkflowValidationTemplate = (
  inspection: Awaited<ReturnType<typeof inspectWorkflowValidation>>,
) => inspection.issues.length
  ? [
      `当前错误：${inspection.failure?.path ?? '-'}`,
      ...inspection.issues.map((issue) => `${formatIssue(issue)}\n${issue.template}`),
    ].join('\n\n')
  : '当前没有可展示的 Workflow 校验错误模板。';

export const setWorkflowValidationMode = async ({
  config,
  project,
  job,
  expectedHead,
  mode,
}: {
  config: ProjectsConfig;
  project: ProjectConfig;
  job: JobConfig;
  expectedHead: string;
  mode: ValidationMode;
}) => {
  assertSingleConsumer(config, project, job);
  const contractPath = contractPathFor(job);
  if (path.isAbsolute(contractPath) || contractPath.split('/').includes('..')) {
    throw new Error('contract_path 必须位于目标仓库内。');
  }
  const fullRef = await git(project.path, 'rev-parse', '--symbolic-full-name', project.ref);
  const checkedOutRef = await git(project.path, 'symbolic-ref', '--quiet', 'HEAD').catch(() => '');
  if (!fullRef.startsWith('refs/heads/') || checkedOutRef !== fullRef) {
    throw new Error('目标 ref 不是当前检出的 branch，拒绝写入。');
  }
  const currentHead = await git(project.path, 'rev-parse', project.ref);
  if (currentHead !== expectedHead) return { state: 'stale' as const, head: currentHead };
  if (await git(project.path, 'status', '--porcelain')) throw new Error('目标工作区非 clean，拒绝写入。');
  if (await git(project.path, 'diff', '--name-only', '--diff-filter=U')) throw new Error('目标工作区存在冲突，拒绝写入。');

  const file = path.join(project.path, contractPath);
  const source = await fs.readFile(file, 'utf8');
  const document = parseDocument(source);
  const currentMode = document.getIn(['validation', 'mode']);
  if (currentMode === mode) return { state: 'unchanged' as const, head: currentHead };
  document.setIn(['validation', 'mode'], mode);
  await fs.writeFile(file, document.toString(), 'utf8');
  try {
    await git(project.path, 'add', '--', contractPath);
    await git(project.path, 'commit', '-m', `workflow: set validation mode to ${mode}`);
  } catch (error) {
    await git(project.path, 'restore', '--staged', '--worktree', '--', contractPath).catch(() => undefined);
    throw error;
  }
  return { state: 'updated' as const, head: await git(project.path, 'rev-parse', 'HEAD') };
};

const auditPayload = (requestId: string, values: Record<string, unknown>) =>
  JSON.stringify({ requestId, ...values });

const requestAudit = async (kind: string, requestId: string) => prisma.feishuAdminApproval.findFirst({
  where: { kind, payloadJson: { contains: `\"requestId\":${JSON.stringify(requestId)}` } },
  orderBy: { createdAt: 'desc' },
});

const withWorkflowLock = <T>(key: string, callback: () => Promise<T>) => prisma.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
  return callback();
}, { timeout: 30_000 });

export async function handleWorkflowValidationCommand(
  command: ParsedFeishuCommand,
  context?: FeishuConversationContext,
) {
  if (!context) return '当前 workflow validation 命令需要来自 Feishu webhook 的会话上下文。';
  const config = await loadProjectsConfig();
  const project = findProjectByChatId(config, context.chatId);
  if (!project) return '当前 Feishu 会话未绑定 Workflow 项目。';
  const job = project.jobs.find((candidate) => candidate.type === 'workflow_watcher');
  if (!job) return '当前项目未配置 workflow-watcher。';
  const action = command.args[1];
  const state = await prisma.scheduledJobState.findUnique({
    where: { projectId_jobId: { projectId: project.id, jobId: job.id } },
    select: { cursorJson: true },
  });

  if (action === 'show' && command.args.length === 2 && !Object.keys(command.options).length) {
    return formatWorkflowValidationStatus(await inspectWorkflowValidation(project, job, state?.cursorJson));
  }
  if (action === 'template' && command.args.length === 2 && !Object.keys(command.options).length) {
    return formatWorkflowValidationTemplate(await inspectWorkflowValidation(project, job, state?.cursorJson));
  }

  const expectedHead = command.options.head || '';
  if (!['set', 'repair'].includes(action || '')
    || !/^[0-9a-f]{40}$/.test(expectedHead)
    || Object.keys(command.options).some((key) => key !== 'head')) {
    return '用法：/ap workflow validation show | set <balanced|strict> --head=<40位HEAD> | template | repair --head=<40位HEAD>';
  }
  if (!canManageWorkflowValidation(
    context.senderOpenId,
    isFeishuAdmin(context.senderOpenId),
    project.feishu.approver_open_ids,
  )) return '只有平台管理员或项目审批人可以修改或修复 Workflow 校验。';

  if (action === 'set') {
    const mode = command.args[2];
    if (command.args.length !== 3 || (mode !== 'balanced' && mode !== 'strict')) {
      return '用法：/ap workflow validation set <balanced|strict> --head=<40位HEAD>';
    }
    const requestId = context.messageId || `${context.senderOpenId}:${expectedHead}:${mode}`;
    const prior = await requestAudit('workflow_validation_set', requestId);
    if (prior?.status === 'approved') return `✅ Workflow 校验模式设置请求已完成（幂等）。audit: ${prior.id}`;
    if (prior?.status === 'denied') return `❌ Workflow 校验模式设置请求此前已拒绝。audit: ${prior.id}`;
    const audit = prior ?? await prisma.feishuAdminApproval.create({ data: {
      kind: 'workflow_validation_set',
      status: 'processing',
      requesterOpenId: context.senderOpenId,
      requesterChatId: context.chatId,
      payloadJson: auditPayload(requestId, { projectId: project.id, jobId: job.id, expectedHead, mode }),
      resolvedBy: context.senderOpenId,
    } });
    try {
      const result = await withWorkflowLock(`${project.id}:${job.id}:validation`, () =>
        setWorkflowValidationMode({ config, project, job, expectedHead, mode }));
      await prisma.feishuAdminApproval.update({
        where: { id: audit.id },
        data: { status: result.state === 'stale' ? 'denied' : 'approved', resolvedAt: new Date() },
      });
      if (result.state === 'stale' && prior?.status === 'processing') {
        const current = await inspectWorkflowValidation(project, job, state?.cursorJson);
        if (current.contract.validation?.mode === mode) {
          await prisma.feishuAdminApproval.update({
            where: { id: audit.id }, data: { status: 'approved', resolvedAt: new Date() },
          });
          return `✅ Workflow 校验模式设置请求已完成（重启恢复，幂等）。HEAD：${current.head}\naudit: ${audit.id}`;
        }
      }
      if (result.state === 'stale') {
        return `❌ 命令已过期：预期 HEAD ${expectedHead}，当前 HEAD ${result.head}。`;
      }
      return result.state === 'unchanged'
        ? `✅ Workflow 校验模式已经是 ${mode}（幂等，无提交）。HEAD：${result.head}`
        : `✅ Workflow 校验模式已切换为 ${mode}。新 HEAD：${result.head}\naudit: ${audit.id}`;
    } catch (error) {
      await prisma.feishuAdminApproval.update({
        where: { id: audit.id }, data: { status: 'denied', resolvedAt: new Date() },
      }).catch(() => undefined);
      throw error;
    }
  }

  if (command.args.length !== 2) return '用法：/ap workflow validation repair --head=<40位HEAD>';
  assertSingleConsumer(config, project, job);
  const inspection = await inspectWorkflowValidation(project, job, state?.cursorJson);
  if (inspection.head !== expectedHead) {
    return `❌ 命令已过期：预期 HEAD ${expectedHead}，当前 HEAD ${inspection.head}。`;
  }
  if (!inspection.failure || !inspection.issues.some(({ severity }) => severity === 'error')) {
    return '当前没有可修复的 Workflow 校验失败。';
  }
  const currentBlob = await git(project.path, 'rev-parse', `${inspection.head}:${inspection.failure.path}`);
  if (currentBlob !== inspection.failure.blob) return '失败文档已产生新 blob，请先刷新 validation show。';
  if (await git(project.path, 'status', '--porcelain')) return '目标工作区非 clean，拒绝启动修复。';
  const eventKey = workflowValidationRepairKey(inspection.failure);
  const requestId = context.messageId || `${context.senderOpenId}:${eventKey}`;
  const prior = await requestAudit('workflow_validation_repair', requestId);
  if (prior?.status === 'denied') return `❌ Workflow 校验修复请求此前已拒绝。audit: ${prior.id}`;
  const existing = await prisma.workflowDispatch.findUnique({
    where: { projectId_jobId_eventKey: { projectId: project.id, jobId: job.id, eventKey } },
  });
  if (existing) {
    if (prior?.status === 'processing') await prisma.feishuAdminApproval.update({
      where: { id: prior.id }, data: { status: 'approved', resolvedAt: new Date() },
    });
    return `✅ 同一文档 blob 的受控修复已登记（${existing.state}），不会重复派单。`;
  }
  const audit = prior ?? await prisma.feishuAdminApproval.create({ data: {
    kind: 'workflow_validation_repair',
    status: 'processing',
    requesterOpenId: context.senderOpenId,
    requesterChatId: context.chatId,
    payloadJson: auditPayload(requestId, { projectId: project.id, jobId: job.id, expectedHead, eventKey }),
    resolvedBy: context.senderOpenId,
  } });
  try {
    const started = await runWorkflowInBoundLiveRoom({
      projectId: project.id,
      jobId: job.id,
      chatId: String(job.config.coding_bot_chat_id || project.feishu.chat_id),
      chatType: String(job.config.coding_bot_chat_type || 'group') === 'p2p' ? 'p2p' : 'group',
      eventKey,
      executionPolicy: validateWorkflowExecutionPolicy(
        job.config.execution_policy,
        `job ${project.id}/${job.id}.config.execution_policy`,
      ),
      workflowContext: `**Workflow 校验修复**\n**文档**：${inspection.failure.path}\n**HEAD**：${inspection.head}`,
      prompt: [
        `修复 ${inspection.failure.path} 的 Workflow 校验错误并提交；不要执行下一 Slice。`,
        ...inspection.issues.map((issue) => `${formatIssue(issue)}\n最小模板：\n${issue.template}`),
        '优先继续当前 Session；若无法续接，平台才会创建一次受控修复 Session。相同 path + blob 不重复派单。',
      ].join('\n\n'),
      signal: new AbortController().signal,
    });
    await prisma.feishuAdminApproval.update({
      where: { id: audit.id }, data: { status: 'approved', resolvedAt: new Date() },
    });
    return started
      ? `✅ 受控修复已投递。event: ${eventKey}\naudit: ${audit.id}`
      : '当前原 Session 尚未完成；修复已登记，将由现有 completion/watcher 链继续。';
  } catch (error) {
    await prisma.feishuAdminApproval.update({
      where: { id: audit.id }, data: { status: 'denied', resolvedAt: new Date() },
    }).catch(() => undefined);
    throw error;
  }
}
