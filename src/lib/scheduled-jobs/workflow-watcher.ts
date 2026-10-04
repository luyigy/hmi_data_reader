import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { importMarkdownAsFeishuDocument } from '../feishu-document-import';
import {
  sendFeishuWorkflowRevisionFeedbackCard,
  sendFeishuWorkflowReviewCard,
  sendFeishuWorkflowTextMessage,
  updateFeishuApprovalCardResolved,
} from '../feishu-api';
import {
  type WorkflowReviewPending,
} from './workflow-review';
import type { JobHandler } from './handlers';
import {
  validateWorkflowExecutionPolicy,
  type WorkflowExecutionPolicy,
} from '../workflow-execution-policy';
import {
  readWorkflowContract,
  selectWorkflowCandidates,
  validateWorkflowDocument,
  WorkflowDocumentValidationError,
  workflowFrontMatter,
  type WorkflowContract,
} from './workflow-validator';
import { ensureAppendOnlyGitRef } from './git-history-guard';
import {
  buildWorkflowCompletionReceipt,
  extractWorkflowValidationSummary,
} from './workflow-status';
import {
  configuredWorkflowAutonomy,
  workflowAutonomyAllows,
  type WorkflowRoleLevel,
} from './workflow-autonomy';
import { loadProjectsConfig, type ProjectsConfig } from './project-config';
import { proposeNextWorkflowInboxPlan } from './workflow-roadmap-inbox';
import { inspectProjectBranch } from './project-branch';
import { reviewQuarantinedDocument } from './workflow-quarantine-review';

type Pending = WorkflowReviewPending & {
  key: string;
  commit: string;
  path: string;
  blob: string;
  action: string;
  type: string;
  documentCommit: string;
  documentUrl: string;
  prompt: string;
  detectedAt: string;
  reviewExpiresAt?: string;
  revisionDispatchKey?: string;
  workflowContext: string;
};

type ValidationFailure = {
  key: string;
  path: string;
  blob: string;
  error: string;
  notified?: boolean;
  quarantined?: boolean;
};

type WorkflowBlocker = {
  key: string;
  error: string;
  notified?: boolean;
  dispatched?: boolean;
};

type Cursor = {
  commit: string;
  eventKey?: string;
  selectedPlan?: string;
  pending?: Pending;
  validationFailure?: ValidationFailure;
  blocker?: WorkflowBlocker;
};
type WorkflowRunner = (args: {
  projectId: string;
  jobId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  prompt: string;
  workflowContext?: string;
  executionPolicy: WorkflowExecutionPolicy;
  eventKey: string;
  roleWorkflow: boolean;
  roleWorkflowLevel?: WorkflowRoleLevel;
  roleWorkflowApprovedPlan?: boolean;
  signal: AbortSignal;
}) => Promise<void | boolean>;
type WorkflowDocumentImporter = (args: {
  content: string;
  name: string;
  idempotencyKey: string;
  signal: AbortSignal;
}) => Promise<string>;
type WorkflowReviewCardSender = typeof sendFeishuWorkflowReviewCard;
type WorkflowReviewCardExpirer = (messageId: string) => Promise<void>;
type ProjectsConfigLoader = () => Promise<ProjectsConfig>;

const declared = (value: unknown) => typeof value === 'string' && value.trim() ? value : '未声明';

const workflowContext = (
  metadata: Record<string, unknown>,
  documentPath: string,
  type: string,
  targetSlice?: string,
) => {
  const lines = [
    `**所属 PLAN**：${type === 'PLAN' ? documentPath : declared(metadata.plan)}`,
  ];
  if (type === 'HANDOVER') {
    lines.push(`**交接 Slice（HANDOVER）**：${declared(metadata.slice)}`);
    if (targetSlice) {
      lines.push(`**目标 Slice**：${targetSlice}`);
    }
  } else {
    lines.push(`**当前或将执行的 Slice**：${declared(metadata.slice)}`);
  }
  lines.push(
    `**计划进度**：${declared(metadata.plan_progress)}`,
    `**文档状态**：${declared(metadata.doc_status)}`,
    `**下一动作**：${declared(metadata.next_action)}`,
  );
  return lines.join('\n');
};

const exec = (file: string, args: string[], signal: AbortSignal, cwd?: string) =>
  new Promise<string>((resolve, reject) => {
    execFile(file, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      signal,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });

const git = (cwd: string, signal: AbortSignal, ...args: string[]) =>
  exec('git', ['-c', 'core.quotepath=false', ...args], signal, cwd);

const workflowCursor = (cursor: unknown, initialCommit: unknown): Cursor => {
  if (cursor && typeof cursor === 'object' && 'commit' in cursor && typeof cursor.commit === 'string') {
    return cursor as Cursor;
  }
  if (typeof initialCommit !== 'string' || !initialCommit) {
    throw new Error('workflow_watcher requires config.initial_cursor_commit for first run');
  }
  return { commit: initialCommit };
};

const documentCommit = async (cwd: string, head: string, filePath: string, signal: AbortSignal) => {
  const commit = (await git(cwd, signal, 'log', '-1', '--format=%H', head, '--', filePath)).trim();
  if (!commit) throw new Error(`cannot resolve document commit: ${filePath}`);
  return commit;
};

const idempotencyKey = (eventKey: string, step: string) =>
  createHash('sha256').update(`${eventKey}:${step}`).digest('hex').slice(0, 32);

const importPlanDocument: WorkflowDocumentImporter = importMarkdownAsFeishuDocument;

const send = (chatId: string, text: string, eventKey: string, step: string) =>
  sendFeishuWorkflowTextMessage({
    chatId,
    text,
    idempotencyKey: idempotencyKey(eventKey, step),
  });

const reviewExpiry = (contract: WorkflowContract) =>
  new Date(Date.now() + contract.completion_gate.timeout_seconds * 1000).toISOString();

const sendReviewCard = (
  project: Parameters<JobHandler>[0]['project'],
  jobId: string,
  pending: Pick<Pending, 'key' | 'path' | 'documentCommit' | 'documentUrl' | 'reviewAttempt' | 'reviewExpiresAt' | 'workflowContext'>,
  sender: WorkflowReviewCardSender,
) => sender({
  chatId: project.feishu.chat_id,
  projectId: project.id,
  jobId,
  pendingKey: pending.key,
  approverOpenId: project.feishu.approver_open_ids[0],
  planPath: pending.path,
  planUrl: pending.documentUrl,
  reviewedCommit: pending.documentCommit,
  expiresAt: pending.reviewExpiresAt!,
  reviewAttempt: pending.reviewAttempt ?? 1,
  idempotencyKey: idempotencyKey(
    pending.key,
    (pending.reviewAttempt ?? 1) === 1 ? 'plan_review' : `plan_review:${pending.reviewAttempt}`,
  ),
  workflowContext: pending.workflowContext,
});

const execute = async (
  pending: Pick<Pending, 'key' | 'prompt' | 'workflowContext' | 'roleWorkflowLevel'>
    & Partial<Pick<Pending, 'reviewState' | 'reviewMessageId' | 'action'>> & {
    roleWorkflow?: boolean;
    type?: string;
  },
  projectId: string,
  jobId: string,
  codingBotChatId: string,
  codingBotChatType: 'group' | 'p2p',
  executionPolicy: WorkflowExecutionPolicy,
  runWorkflow: WorkflowRunner,
  signal: AbortSignal,
) => {
  const validationReminder = [
    '',
    '完成前必须以目标 HEAD 中的 docs/workflow/workflow-contract.yaml 为唯一规则源，',
    '只修订并提交本次相关 PLAN/HANDOVER；平台 completion gate 会在 Session 结束后统一校验。',
  ].join('\n');
  const approvalNotice = pending.type === 'PLAN' && pending.reviewState === 'approved' && pending.reviewMessageId
    ? `**平台审批状态**：人工审批卡已批准（消息 ${pending.reviewMessageId}）。watcher 已将本次运行时动作转换为 ${pending.action}；下方 await_approval 是已提交 PLAN 的提审时原值，不表示仍待审批。请直接执行获批的首个 Slice，无需再次请求批准。`
    : '';
  const workflowContext = approvalNotice
    ? `${approvalNotice}\n${pending.workflowContext}`
    : pending.workflowContext;
  return (await runWorkflow({
    projectId,
    jobId,
    chatId: codingBotChatId,
    chatType: codingBotChatType,
    prompt: `${workflowContext}\n\n${pending.prompt}\n${validationReminder}`,
    workflowContext,
    executionPolicy,
    eventKey: pending.key,
    roleWorkflow: pending.roleWorkflow ?? ['PLAN', 'HANDOVER'].includes(pending.type || ''),
    roleWorkflowLevel: pending.roleWorkflowLevel
      ?? (pending.type === 'PLAN' ? 'lean' : pending.type === 'HANDOVER' ? 'fast' : undefined),
    roleWorkflowApprovedPlan: ['PLAN', 'HANDOVER'].includes(pending.type || ''),
    signal,
  })) !== false;
};

export const workflowWatcherHandler = async (
  {
    project,
    job,
    mode,
    trigger = 'schedule',
    workflowAutonomy,
    workflowRoleLevel,
    cursor,
    signal,
  }: Parameters<JobHandler>[0],
  runWorkflow?: WorkflowRunner,
  importDocument: WorkflowDocumentImporter = importPlanDocument,
  sendReview: WorkflowReviewCardSender = sendFeishuWorkflowReviewCard,
  expireReview: WorkflowReviewCardExpirer = (messageId) => updateFeishuApprovalCardResolved({
    messageId,
    resolution: 'expired',
    actorName: 'Workflow watcher',
  }),
  loadProjectRegistry: ProjectsConfigLoader = loadProjectsConfig,
) => {
  const executionPolicy = validateWorkflowExecutionPolicy(
    job.config.execution_policy,
    `job ${project.id}/${job.id}.config.execution_policy`,
  );
  const autonomy = workflowAutonomy ?? configuredWorkflowAutonomy(job);
  const allows = (advance: string) => workflowAutonomyAllows(autonomy, advance, trigger);
  const contractPath = String(job.config.contract_path || '');
  if (!contractPath || path.isAbsolute(contractPath) || contractPath.split('/').includes('..')) {
    throw new Error('contract_path must stay inside the repository');
  }
  const activeEnabled = job.config.active_side_effects_enabled === true;
  if (mode === 'active' && !activeEnabled) throw new Error('workflow_watcher active side effects require explicit config gate');
  const codingBotChatId = String(job.config.coding_bot_chat_id || '');
  const codingBotChatType = job.config.coding_bot_chat_type;
  if (mode === 'active' && (
    !codingBotChatId
    || (codingBotChatType !== 'group' && codingBotChatType !== 'p2p')
    || project.feishu.approver_open_ids.length !== 1
  )) {
    throw new Error('workflow_watcher active identity config is incomplete');
  }

  await ensureAppendOnlyGitRef(project.path, project.ref, signal, contractPath);
  const head = (await git(project.path, signal, 'rev-parse', '--verify', `${project.ref}^{commit}`)).trim();

  const branchInfo = await inspectProjectBranch(project.path, project.ref).catch(() => null);
  if (branchInfo?.isDrifted && mode === 'active') {
    const driftKey = `${project.id}:${branchInfo.actualBranch}:branch_drift`;
    await send(
      project.feishu.chat_id,
      [
        `⚠️ **【监控分支漂移警告】**`,
        `项目：**${project.name}** (\`${project.id}\`)`,
        `仓库路径：\`${project.path}\``,
        `仓库当前实际分支：\`${branchInfo.actualBranch}\``,
        `系统当前监控分支：\`${branchInfo.monitoredBranch}\``,
        '',
        `🚨 **风险说明**：当前 Git 检出分支与系统监控分支不匹配，推送到当前分支的 Commit 及 PLAN/HANDOVER 自动化将**无法被自动触发**！`,
        '',
        `💡 **如何处理**：`,
        `• 非管理员申请切换监控分支：\`/ap branch apply\``,
        `• 管理员直接切换监控分支：\`/ap branch switch ${branchInfo.actualBranch}\``,
      ].join('\n'),
      driftKey,
      'branch_drift_warning',
    ).catch((err) => console.error('[WorkflowWatcher] failed to send branch drift warning', err));
  }
  let previous = workflowCursor(cursor, job.config.initial_cursor_commit);
  const contract = await readWorkflowContract(project.path, head, contractPath, signal);
  const branchSpace = String(job.config.branch_space || '');
  if (!branchSpace || branchSpace.includes('/') || branchSpace === '..') {
    throw new Error('workflow_watcher requires a single-directory config.branch_space');
  }
  const watchRoot = path.posix.join(contract.branch_spaces.root, branchSpace);
  const block = async (reason: string, nextStep: string) => {
    // Remediation may advance HEAD while the blocked cursor intentionally stays fixed.
    const key = `${previous.commit}:${reason}`;
    const legacyKeyPrefix = `${previous.commit}:`;
    const prior = previous.blocker
      && (previous.blocker.key === key
        || (previous.blocker.key.startsWith(legacyKeyPrefix) && previous.blocker.key.endsWith(`:${reason}`)))
      ? { ...previous.blocker, key }
      : { key, error: reason };
    let notified = prior.notified === true;
    let dispatched = prior.dispatched === true;
    if (mode === 'active' && !notified) {
      await send(project.feishu.chat_id, [
        '🚧 Workflow 自动化已暂停，需处理后才能继续。',
        `原因：${reason}`,
        `watcher 游标：${previous.commit}`,
        `目标 ref HEAD：${head}`,
        `建议动作：${nextStep}`,
        '平台已请求 Coding Agent 分析并推进；涉及移动游标或改写 Git 历史时仍需人工确认。',
      ].join('\n'), key, 'blocker');
      notified = true;
    }
    if (mode === 'active' && !dispatched) {
      dispatched = await execute({
        key,
        workflowContext: `Workflow blocker\nproject: ${project.id}\nref: ${project.ref}`,
        prompt: [
          'WORKFLOW_BLOCKER',
          `error: ${reason}`,
          `project_path: ${project.path}`,
          `target_ref: ${project.ref}`,
          `watcher_cursor: ${previous.commit}`,
          `target_head: ${head}`,
          `suggested_next_step: ${nextStep}`,
          '',
          '请检查真实状态并在现有权限内直接推进可安全处理的部分。',
          '不得改写 Git 历史或擅自移动 watcher 游标；若必须人工确认，请给出明确原因、准确命令和预期影响。',
        ].join('\n'),
      }, project.id, job.id, codingBotChatId, codingBotChatType as 'group' | 'p2p',
      executionPolicy, runWorkflow ?? (await import('../feishu-workflow')).runWorkflowInBoundLiveRoom, signal);
    }
    return {
      summary: `head=${head} gate=blocked error=${reason} notified=${notified} dispatched=${dispatched}`,
      cursor: { ...previous, blocker: { key, error: reason, notified, dispatched } },
    };
  };
  const ancestor = await git(project.path, signal, 'merge-base', '--is-ancestor', previous.commit, head)
    .then(() => true, () => false);
  if (!ancestor) {
    return block(
      'configured Git ref was rewritten; human review required',
      '确认历史分叉后，将 watcher 游标恢复到需要重新扫描范围之前的安全提交，再手动运行 watcher。',
    );
  }
  if (contract.legacy.cutoff_commit) {
    const aboveCutoff = await git(project.path, signal, 'merge-base', '--is-ancestor', contract.legacy.cutoff_commit, previous.commit)
      .then(() => true, () => false);
    if (!aboveCutoff) {
      return block(
        'cursor precedes contract cutoff; human review required',
        '核对合同 cutoff 后，将 watcher 游标移动到 cutoff 或其后的安全提交，再手动运行 watcher。',
      );
    }
  }

  let supersededSummary = '';
  if (previous.pending) {
    const pendingCandidate = selectWorkflowCandidates([previous.pending.path], contract, watchRoot)[0];
    const changed = previous.commit === head ? [] : (await git(
      project.path, signal, 'diff', '--name-only', '--diff-filter=AMR', previous.commit, head, '--', watchRoot,
    )).trim().split('\n').filter(Boolean);
    const newerCandidates = selectWorkflowCandidates(changed, contract, watchRoot)
      .filter(({ number }) => pendingCandidate && number > pendingCandidate.number)
      .reverse();
    let superseder: typeof newerCandidates[number] | undefined;
    for (const candidate of newerCandidates) {
      try {
        const content = await git(project.path, signal, 'show', `${head}:${candidate.filePath}`);
        await validateWorkflowDocument(
          project.path, head, candidate.filePath, candidate.type, content,
          workflowFrontMatter(content), contract, watchRoot, signal,
        );
        superseder = candidate;
        break;
      } catch (error) {
        if (!(error instanceof WorkflowDocumentValidationError)) throw error;
      }
    }
    if (superseder) {
      supersededSummary = `head=${head} pending_superseded=${previous.pending.path} by=${superseder.filePath}`;
      if (mode === 'shadow') return { summary: supersededSummary, cursor: previous };
      if (previous.pending.gate === 'plan_review' && previous.pending.reviewMessageId) {
        await expireReview(previous.pending.reviewMessageId)
          .catch((error) => console.error('[WorkflowReview] failed to expire superseded card', error));
      }
      previous = { ...previous, selectedPlan: superseder.filePath };
      delete previous.pending;
    }
  }

  if (previous.pending) {
    if (!contract.legacy.automation_enabled) {
      return { summary: `head=${head} pending=${previous.pending.path} gate=automation_disabled`, cursor: previous };
    }
    let pending = workflowRoleLevel
      ? { ...previous.pending, roleWorkflowLevel: workflowRoleLevel }
      : previous.pending;
    if (pending.gate === 'plan_review'
      && !['revision', 'revision_requested', 'awaiting_revision_feedback'].includes(pending.reviewState || '')) {
      const currentBlob = (await git(project.path, signal, 'rev-parse', `${head}:${pending.path}`)).trim();
      if (currentBlob !== pending.blob) {
        if (mode === 'shadow') {
          return { summary: `head=${head} pending=${pending.path} gate=plan_review changed=true`, cursor: previous };
        }
        if (pending.reviewMessageId) {
          await expireReview(pending.reviewMessageId)
            .catch((error) => console.error('[WorkflowReview] failed to expire changed card', error));
        }
        pending = { ...pending, reviewState: 'revision' };
      }
    }
    const revisionPrompt = () => {
      const feedback = pending.reviewFeedback?.trim();
      return `PLAN_REVISE\nplan_path: ${pending.path}\n`
        + `reviewed_commit: ${pending.documentCommit}\nfeedback:\n${feedback || '审批人未填写具体修改意见。'}\n\n`
        + (!feedback ? '请先主动询问审批人需要修改的内容，得到答复后再修订。\n' : '')
        + '只修订并提交该 PLAN，不执行任何 Slice。';
    };
    if (pending.gate === 'plan_review' && pending.reviewState === 'awaiting_revision_feedback') {
      if (mode !== 'active' || pending.revisionFeedbackMessageId) {
        return { summary: `head=${head} pending=${pending.path} gate=revision_feedback`, cursor: previous };
      }
      const revisionFeedbackMessageId = await sendFeishuWorkflowRevisionFeedbackCard({
        chatId: project.feishu.chat_id,
        projectId: project.id,
        jobId: job.id,
        pendingKey: pending.key,
        approverOpenId: project.feishu.approver_open_ids[0],
        planPath: pending.path,
        idempotencyKey: idempotencyKey(pending.key, 'revision_feedback_request'),
      });
      pending = { ...pending, revisionFeedbackMessageId };
      return {
        summary: `head=${head} pending=${pending.path} gate=revision_feedback prompt_sent=true`,
        cursor: { ...previous, pending },
      };
    }
    if (pending.gate === 'plan_review' && pending.reviewState === 'revision_requested') {
      if (!allows('revision')) {
        return { summary: `head=${head} pending=${pending.path} gate=autonomy_manual advance=revision`, cursor: previous };
      }
      const revisionBaseBlob = (await git(
        project.path, signal, 'rev-parse', `${head}:${pending.path}`,
      )).trim();
      if (mode === 'active') {
        await execute(
          {
            ...pending,
            key: pending.revisionDispatchKey || pending.key,
            prompt: revisionPrompt(),
            roleWorkflow: false,
          },
          project.id,
          job.id,
          codingBotChatId,
          codingBotChatType as 'group' | 'p2p',
          executionPolicy,
          runWorkflow ?? (await import('../feishu-workflow')).runWorkflowInBoundLiveRoom,
          signal,
        );
      }
      pending = {
        ...pending,
        blob: revisionBaseBlob,
        reviewState: 'revision',
        revisionDispatched: mode === 'active',
      };
      return {
        summary: `head=${head} pending=${pending.path} gate=plan_revision decision=revise`,
        cursor: { ...previous, pending },
      };
    }
    if (pending.gate === 'plan_review' && pending.reviewState === 'revision') {
      const content = await git(project.path, signal, 'show', `${head}:${pending.path}`);
      const blob = (await git(project.path, signal, 'rev-parse', `${head}:${pending.path}`)).trim();
      if (blob === pending.blob) {
        if (mode !== 'active' || pending.revisionDispatched) {
          return { summary: `head=${head} pending=${pending.path} gate=plan_revision`, cursor: previous };
        }
        if (!allows('revision')) {
          return { summary: `head=${head} pending=${pending.path} gate=autonomy_manual advance=revision`, cursor: previous };
        }
        await execute(
          {
            ...pending,
            key: pending.revisionDispatchKey || pending.key,
            prompt: revisionPrompt(),
            roleWorkflow: false,
          },
          project.id,
          job.id,
          codingBotChatId,
          codingBotChatType as 'group' | 'p2p',
          executionPolicy,
          runWorkflow ?? (await import('../feishu-workflow')).runWorkflowInBoundLiveRoom,
          signal,
        );
        pending = { ...pending, revisionDispatched: true };
        return {
          summary: `head=${head} pending=${pending.path} gate=plan_revision dispatch_recovered=true`,
          cursor: { ...previous, pending },
        };
      }
      const metadata = workflowFrontMatter(content);
      const revised = await validateWorkflowDocument(
        project.path, head, pending.path, 'PLAN', content, metadata, contract,
        path.posix.dirname(pending.path), signal,
      );
      if (![contract.documents.plan.start_action, contract.documents.plan.review_action].includes(revised.action)) {
        throw new Error('revised document is not an approvable PLAN');
      }
      const commit = await documentCommit(project.path, head, pending.path, signal);
      const key = `${head}:${pending.path}:${blob}:${revised.action}`;
      const reviewExpiresAt = reviewExpiry(contract);
      const documentUrl = mode === 'active' ? await importDocument({
        content,
        name: path.posix.basename(pending.path, '.md'),
        idempotencyKey: idempotencyKey(key, 'plan_document'),
        signal,
      }) : '';
      pending = {
        ...pending,
        key,
        commit,
        blob,
        documentCommit: commit,
        documentUrl,
        prompt: revised.prompt,
        workflowContext: workflowContext(metadata, pending.path, 'PLAN'),
        reviewState: undefined,
        reviewMessageId: undefined,
        reviewAttempt: 1,
        reviewExpiresAt,
        detectedAt: new Date().toISOString(),
      };
      return {
        summary: `head=${head} pending=${pending.path} gate=plan_review revised=true`,
        cursor: { commit: head, eventKey: key, pending },
      };
    }
    if (pending.gate === 'plan_review') {
      if (pending.reviewExpiresAt
        && new Date(pending.reviewExpiresAt) <= new Date()
        && pending.reviewState === 'review') {
        if (mode === 'active' && pending.reviewMessageId) {
          await expireReview(pending.reviewMessageId)
            .catch((error) => console.error('[WorkflowReview] failed to expire stale card', error));
        }
        pending = {
          ...pending,
          reviewAttempt: (pending.reviewAttempt ?? 1) + 1,
          reviewExpiresAt: reviewExpiry(contract),
          reviewMessageId: undefined,
          reviewState: undefined,
        };
      }
      if (mode === 'active' && !pending.reviewMessageId) {
        const reviewMessageId = await sendReviewCard(project, job.id, pending, sendReview);
        if (!reviewMessageId) throw new Error('plan review request returned no message_id');
        pending = { ...pending, reviewState: 'review', reviewMessageId };
        return {
          summary: `head=${head} pending=${pending.path} gate=plan_review card_sent=true`,
          cursor: { ...previous, pending },
        };
      }
      if (pending.reviewState === 'review') {
        return { summary: `head=${head} pending=${pending.path} gate=plan_review`, cursor: previous };
      }
      if (pending.reviewState !== 'approved') {
        if (pending.reviewState === 'rejected') {
          return {
            summary: `head=${head} candidate=${pending.path} action=${pending.action} result=rejected`,
            cursor: { commit: pending.commit, eventKey: pending.key },
          };
        }
        return {
          summary: `head=${head} pending=${pending.path} gate=plan_revision decision=revise`,
          cursor: { ...previous, pending },
        };
      }
      pending = { ...pending, action: contract.documents.plan.start_action };
      if (!contract.actions.executable.includes(pending.action)) {
        return {
          summary: `head=${head} candidate=${pending.path} action=${pending.action} result=approved`,
          cursor: { commit: head, eventKey: pending.key },
        };
      }
      if (!allows(pending.action)) {
        return {
          summary: `head=${head} pending=${pending.path} gate=autonomy_manual advance=${pending.action}`,
          cursor: previous,
        };
      }
    }
    if (!allows(pending.action)) {
      return {
        summary: `head=${head} pending=${pending.path} gate=autonomy_manual advance=${pending.action}`,
        cursor: previous,
      };
    }
    if (mode === 'active') {
      const started = await execute(
        pending,
        project.id,
        job.id,
        codingBotChatId,
        codingBotChatType as 'group' | 'p2p',
        executionPolicy,
        runWorkflow ?? (await import('../feishu-workflow')).runWorkflowInBoundLiveRoom,
        signal,
      );
      if (!started) return { summary: `head=${head} pending=${pending.path} gate=waiting_previous_completion`, cursor: previous };
    }
    return {
      summary: `head=${head} candidate=${pending.path} action=${pending.action} result=${mode === 'active' ? 'session_started' : 'shadow'}`,
      cursor: { commit: pending.gate === 'workflow_ready' ? previous.commit : head, eventKey: pending.key },
    };
  }

  const scanFrom = previous.eventKey ? previous.commit : String(job.config.initial_cursor_commit);
  const selectedPlan = previous.selectedPlan;
  const changed = selectedPlan
    ? [selectedPlan]
    : scanFrom === head ? [] : (await git(
      project.path, signal, 'diff', '--name-only', '--diff-filter=AMR', scanFrom, head, '--', watchRoot,
    )).trim().split('\n').filter(Boolean);
  const candidates = selectWorkflowCandidates(changed, contract, watchRoot);
  // Quarantined failures ride along with cursor updates so the document is
  // re-reviewed once the candidate queue drains, instead of being forgotten.
  const carryQuarantine = (cursor: Cursor): Cursor => (previous.validationFailure?.quarantined
    ? { ...cursor, validationFailure: previous.validationFailure }
    : cursor);

  if (!candidates.length && previous.validationFailure?.quarantined) {
    // Quarantine auto-review: with an empty candidate queue, re-validate the
    // quarantined number at head so a resolved conflict (duplicate renamed or
    // finalized) advances without an artificial re-commit. Unresolved reviews
    // stay quarantined and never re-notify (throttle).
    const review = await reviewQuarantinedDocument({
      cwd: project.path,
      head,
      failurePath: previous.validationFailure.path,
      contract,
      git: (...args: string[]) => git(project.path, signal, ...args),
      signal,
    });
    if (review.status !== 'resolved') {
      return {
        summary: `head=${head} candidate=none quarantine_review=${review.status}`,
        cursor: carryQuarantine({ commit: head, eventKey: previous.eventKey }),
      };
    }
    candidates.push(review.candidate);
    previous = { ...previous };
    delete previous.validationFailure;
  }

  if (!candidates.length) return { summary: `head=${head} candidate=none`, cursor: { commit: head, eventKey: previous.eventKey } };
  const candidate = candidates.at(-1)!;
  const blob = (await git(project.path, signal, 'rev-parse', `${head}:${candidate.filePath}`)).trim();
  const content = await git(project.path, signal, 'show', `${head}:${candidate.filePath}`);
  let metadata: Record<string, unknown>;
  let document: Awaited<ReturnType<typeof validateWorkflowDocument>>;
  try {
    if (candidate.rawNumber.length !== contract.numbering.width) {
      throw new WorkflowDocumentValidationError('workflow document number has invalid width');
    }
    if (contract.numbering.unique && candidates.filter((item) => item.number === candidate.number).length !== 1) {
      throw new WorkflowDocumentValidationError(`multiple workflow documents use number ${candidate.number}`);
    }
    try {
      metadata = workflowFrontMatter(content);
    } catch (error) {
      throw new WorkflowDocumentValidationError(error instanceof Error ? error.message : String(error));
    }
    document = await validateWorkflowDocument(
      project.path, head, candidate.filePath, candidate.type, content, metadata, contract, watchRoot, signal,
    );
  } catch (error) {
    if (!(error instanceof WorkflowDocumentValidationError)) throw error;
    const key = `${candidate.filePath}:${blob}:validation_failed`;
    const prior = previous.validationFailure?.key === key ? previous.validationFailure : undefined;
    let failure: ValidationFailure = {
      key,
      path: candidate.filePath,
      blob,
      error: error instanceof Error ? error.message : String(error),
      notified: prior?.notified,
      quarantined: prior?.quarantined,
    };
    if (mode === 'active' && !failure.notified) {
      await send(project.feishu.chat_id,
        `❌ workflow validator 未通过：${candidate.filePath}\ncommit: ${head}\n${failure.error}\n未通过校验的文档不会触发下一 Workflow 动作；原执行 Session 会在 completion gate 中自动纠正，修订提交后 watcher 将自动复验。`,
        key, 'validation_failed');
      failure = { ...failure, notified: true };
    }
    if (prior?.notified) {
      // Quarantine: alert once, then advance the cursor past the broken document
      // so it cannot deadlock every later workflow document in the queue.
      // Re-committing a fixed document produces a new blob/eventKey and is
      // validated again from the advanced cursor.
      if (mode === 'active' && !failure.quarantined) {
        await send(project.feishu.chat_id, [
          `🗑 workflow 文档复验仍未通过，已进入隔离区：${candidate.filePath}`,
          `commit: ${head}`,
          failure.error,
          'watcher 游标已前移跳过该文档，后续 Workflow 不再被阻塞；修复并重新提交该文档后将自动重新校验。',
        ].join('\n'), key, 'validation_quarantined');
      }
      failure = { ...failure, quarantined: true };
      return {
        summary: `head=${head} candidate=${candidate.filePath} validation_failed quarantined=true`,
        cursor: { commit: head, eventKey: key, validationFailure: failure },
      };
    }
    return {
      summary: `head=${head} candidate=${candidate.filePath} validation_failed notified=${failure.notified === true}`,
      cursor: { ...previous, validationFailure: failure },
    };
  }
  const commit = await documentCommit(project.path, head, candidate.filePath, signal);
  const eventKey = `${head}:${candidate.filePath}:${blob}:${document.action}`;
  if (previous.eventKey === eventKey && !selectedPlan) {
    return { summary: `head=${head} candidate=${candidate.filePath} duplicate=true`, cursor: carryQuarantine({ commit: head, eventKey }) };
  }
  const gate = !contract.legacy.automation_enabled
    ? 'automation_disabled'
    : candidate.type === 'PLAN'
      && (document.action === contract.documents.plan.start_action
        || (document.action === contract.documents.plan.review_action && selectedPlan === candidate.filePath))
      ? 'plan_review'
      : contract.actions.executable.includes(document.action)
        ? 'execute'
        : 'terminal';
  if (mode === 'shadow' || gate === 'automation_disabled') {
    return {
      summary: `head=${head} candidate=${candidate.filePath} type=${candidate.type} action=${document.action} gate=${gate}`,
      cursor: carryQuarantine({ commit: head, eventKey }),
    };
  }
  await send(project.feishu.chat_id,
    `✅ workflow validator 通过：${candidate.filePath}\ncommit: ${commit}\n${workflowContext(metadata, candidate.filePath, candidate.type, document.nextSlice)}`,
    eventKey, 'validation_passed');
  if (candidate.type === 'HANDOVER') {
    await send(project.feishu.chat_id,
      `${buildWorkflowCompletionReceipt({
        commit,
        documentPath: candidate.filePath,
        action: document.action,
        validation: extractWorkflowValidationSummary(content),
        plan: declared(metadata.plan),
        slice: declared(metadata.slice),
        automaticProgression: gate === 'execute' && !allows(document.action)
          ? '已停止（manual，使用 /ap job run 手动推进）'
          : undefined,
      })}\n${workflowContext(metadata, candidate.filePath, candidate.type, document.nextSlice)}`,
      eventKey, 'completion_receipt');
  }
  if (gate === 'terminal') {
    if (
      candidate.type === 'HANDOVER'
      && autonomy === 'auto'
      && document.action === 'await_acceptance'
      && metadata.plan_progress === 'complete'
    ) {
      let proposal;
      try {
        proposal = await proposeNextWorkflowInboxPlan({
          project,
          job,
          projects: await loadProjectRegistry(),
          head,
          watchRoot,
          contract,
          handoverMetadata: metadata,
          signal,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await send(
          project.feishu.chat_id,
          `Auto Roadmap/Inbox 提议失败并已停止：${reason}`,
          eventKey,
          'auto_plan_failed',
        );
        throw error;
      }
      if (proposal.status === 'created') {
        await send(project.feishu.chat_id, [
          `Auto 已从 Git ${proposal.sourcePath} 生成新的审批 PLAN：${proposal.planPath}`,
          `候选 event key：${proposal.eventKey}`,
          `预期 HEAD：${head}`,
          '下一轮 watcher 将复用现有 PLAN 审批卡；批准前不会实施。',
        ].join('\n'), eventKey, 'auto_plan_created');
        return {
          summary: `head=${head} candidate=${candidate.filePath} auto_plan=${proposal.planPath} result=proposed`,
          cursor: previous,
        };
      }
      await send(
        project.feishu.chat_id,
        `Auto Roadmap/Inbox 已停止：${proposal.reason}`,
        eventKey,
        'auto_plan_stopped',
      );
    }
    if (candidate.type !== 'HANDOVER') {
      await send(project.feishu.chat_id,
        `[workflow-watcher] ${path.posix.basename(candidate.filePath)}: next_action=${document.action}，不启动新 Session。\n${workflowContext(metadata, candidate.filePath, candidate.type, document.nextSlice)}`,
        eventKey, 'terminal');
    }
    return {
      summary: `head=${head} commit=${commit} candidate=${candidate.filePath} action=${document.action} result=notified`,
      cursor: carryQuarantine({ commit: head, eventKey }),
    };
  }
  const detectedAt = new Date().toISOString();
  const execution = {
    key: eventKey,
    prompt: document.prompt,
    workflowContext: workflowContext(metadata, candidate.filePath, candidate.type, document.nextSlice),
  };
  if (gate === 'plan_review') {
    const documentUrl = await importDocument({
      content,
      name: path.posix.basename(candidate.filePath, '.md'),
      idempotencyKey: idempotencyKey(eventKey, 'plan_document'),
      signal,
    });
    const pending: Pending = {
      ...execution,
      commit,
      path: candidate.filePath,
      blob,
      action: document.action,
      type: candidate.type,
      documentCommit: commit,
      documentUrl,
      gate,
      reviewState: undefined,
      reviewAttempt: 1,
      reviewExpiresAt: reviewExpiry(contract),
      detectedAt,
      workflowContext: execution.workflowContext,
      roleWorkflowLevel: workflowRoleLevel,
    };
    const reviewMessageId = await sendReviewCard(project, job.id, pending, sendReview);
    if (!reviewMessageId) throw new Error('plan review request returned no message_id');
    return {
      summary: `head=${head} candidate=${candidate.filePath} action=${document.action} gate=${gate} document_ready=true card_sent=true`,
      cursor: carryQuarantine({
        commit: head,
        eventKey,
        pending: { ...pending, reviewState: 'review', reviewMessageId },
      }),
    };
  }
  const pending: Pending = {
    ...execution,
    commit,
    path: candidate.filePath,
    blob,
    action: document.action,
    type: candidate.type,
    documentCommit: commit,
    documentUrl: '',
    gate: 'workflow_ready',
    detectedAt,
    roleWorkflowLevel: workflowRoleLevel,
  };
  if (!allows(pending.action)) {
    return {
      summary: `head=${head} candidate=${candidate.filePath} gate=autonomy_manual advance=${pending.action}`,
      cursor: carryQuarantine({ commit: head, eventKey, pending }),
    };
  }
  const started = await execute(
    pending,
    project.id,
    job.id,
    codingBotChatId,
    codingBotChatType as 'group' | 'p2p',
    executionPolicy,
    runWorkflow ?? (await import('../feishu-workflow')).runWorkflowInBoundLiveRoom,
    signal,
  );
  if (!started) {
    return {
      summary: `${supersededSummary ? `${supersededSummary} ` : ''}head=${head} candidate=${candidate.filePath} action=${document.action} gate=waiting_previous_completion`,
      cursor: carryQuarantine({ commit: head, eventKey, pending }),
    };
  }
  return {
    summary: `${supersededSummary ? `${supersededSummary} ` : ''}head=${head} commit=${commit} candidate=${candidate.filePath} action=${document.action} result=session_started`,
    cursor: carryQuarantine({ commit: head, eventKey }),
  };
};
