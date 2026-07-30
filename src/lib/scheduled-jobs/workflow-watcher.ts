import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  workflowFrontMatter,
  type WorkflowContract,
} from './workflow-validator';
import { ensureAppendOnlyGitRef } from './git-history-guard';

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

const declared = (value: unknown) => typeof value === 'string' && value.trim() ? value : '未声明';

const workflowContext = (metadata: Record<string, unknown>, documentPath: string, type: string) => [
  `**所属 PLAN**：${type === 'PLAN' ? documentPath : declared(metadata.plan)}`,
  `**当前或将执行的 Slice**：${declared(metadata.slice)}`,
  `**计划进度**：${declared(metadata.plan_progress)}`,
  `**文档状态**：${declared(metadata.doc_status)}`,
  `**下一动作**：${declared(metadata.next_action)}`,
].join('\n');

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

const importPlanDocument: WorkflowDocumentImporter = async ({ content, name, signal }) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-platform-plan-'));
  const file = path.join(directory, 'plan.md');
  try {
    const body = content
      .replace(/^---\n[\s\S]*?\n---\n*/, '')
      .replace(/^# [^\n]*\n*/, '');
    await writeFile(file, `# ${name}\n\n${body}`);
    const result = JSON.parse(await exec('lark-cli', [
      'docs', '+create', '--as', 'bot', '--api-version', 'v2',
      '--doc-format', 'markdown', '--content', '@plan.md', '--format', 'json',
    ], signal, directory)) as Record<string, unknown>;
    const data = result.data as { document?: { url?: unknown } } | undefined;
    if (result.ok !== true || typeof data?.document?.url !== 'string' || !data.document.url) {
      throw new Error('Feishu PLAN creation returned no document URL');
    }
    return data.document.url;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

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
  pending: Pick<Pending, 'key' | 'prompt' | 'workflowContext'>,
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
  return (await runWorkflow({
    projectId,
    jobId,
    chatId: codingBotChatId,
    chatType: codingBotChatType,
    prompt: `${pending.workflowContext}\n\n${pending.prompt}\n${validationReminder}`,
    workflowContext: pending.workflowContext,
    executionPolicy,
    eventKey: pending.key,
    signal,
  })) !== false;
};

export const workflowWatcherHandler = async (
  { project, job, mode, cursor, signal }: Parameters<JobHandler>[0],
  runWorkflow?: WorkflowRunner,
  importDocument: WorkflowDocumentImporter = importPlanDocument,
  sendReview: WorkflowReviewCardSender = sendFeishuWorkflowReviewCard,
  expireReview: WorkflowReviewCardExpirer = (messageId) => updateFeishuApprovalCardResolved({
    messageId,
    resolution: 'expired',
    actorName: 'Workflow watcher',
  }),
) => {
  const executionPolicy = validateWorkflowExecutionPolicy(
    job.config.execution_policy,
    `job ${project.id}/${job.id}.config.execution_policy`,
  );
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

  await ensureAppendOnlyGitRef(project.path, project.ref, signal);
  const head = (await git(project.path, signal, 'rev-parse', '--verify', `${project.ref}^{commit}`)).trim();
  const previous = workflowCursor(cursor, job.config.initial_cursor_commit);
  const contract = await readWorkflowContract(project.path, head, contractPath, signal);
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

  if (previous.pending) {
    if (!contract.legacy.automation_enabled) {
      return { summary: `head=${head} pending=${previous.pending.path} gate=automation_disabled`, cursor: previous };
    }
    let pending = previous.pending;
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
      const revisionBaseBlob = (await git(
        project.path, signal, 'rev-parse', `${head}:${pending.path}`,
      )).trim();
      if (mode === 'active') {
        await execute(
          { ...pending, key: pending.revisionDispatchKey || pending.key, prompt: revisionPrompt() },
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
        await execute(
          { ...pending, key: pending.revisionDispatchKey || pending.key, prompt: revisionPrompt() },
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
      if (revised.action !== contract.documents.plan.start_action) {
        throw new Error('revised document is not an executable PLAN');
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
      if (!contract.actions.executable.includes(pending.action)) {
        return {
          summary: `head=${head} candidate=${pending.path} action=${pending.action} result=approved`,
          cursor: { commit: head, eventKey: pending.key },
        };
      }
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
      cursor: { commit: head, eventKey: pending.key },
    };
  }

  const branchSpace = String(job.config.branch_space || '');
  if (!branchSpace || branchSpace.includes('/') || branchSpace === '..') {
    throw new Error('workflow_watcher requires a single-directory config.branch_space');
  }
  const watchRoot = path.posix.join(contract.branch_spaces.root, branchSpace);
  const scanFrom = previous.eventKey ? previous.commit : String(job.config.initial_cursor_commit);
  const changed = scanFrom === head ? [] : (await git(
    project.path, signal, 'diff', '--name-only', '--diff-filter=AMR', scanFrom, head, '--', watchRoot,
  )).trim().split('\n').filter(Boolean);
  const candidates = selectWorkflowCandidates(changed, contract, watchRoot);

  if (!candidates.length) return { summary: `head=${head} candidate=none`, cursor: { commit: head, eventKey: previous.eventKey } };
  const candidate = candidates.at(-1)!;
  if (candidate.rawNumber.length !== contract.numbering.width) throw new Error('workflow document number has invalid width');
  if (contract.numbering.unique && candidates.filter((item) => item.number === candidate.number).length !== 1) {
    throw new Error(`multiple workflow documents use number ${candidate.number}`);
  }

  const blob = (await git(project.path, signal, 'rev-parse', `${head}:${candidate.filePath}`)).trim();
  const content = await git(project.path, signal, 'show', `${head}:${candidate.filePath}`);
  let metadata: Record<string, unknown>;
  let document: Awaited<ReturnType<typeof validateWorkflowDocument>>;
  try {
    metadata = workflowFrontMatter(content);
    document = await validateWorkflowDocument(
      project.path, head, candidate.filePath, candidate.type, content, metadata, contract, watchRoot, signal,
    );
  } catch (error) {
    const key = `${candidate.filePath}:${blob}:validation_failed`;
    let failure = previous.validationFailure?.key === key
      ? previous.validationFailure
      : {
        key,
        path: candidate.filePath,
        blob,
        error: error instanceof Error ? error.message : String(error),
      };
    if (mode === 'active' && !failure.notified) {
      await send(project.feishu.chat_id,
        `❌ workflow validator 未通过：${candidate.filePath}\ncommit: ${head}\n${failure.error}\n未通过校验的文档不会触发下一 Workflow 动作；原执行 Session 会在 completion gate 中自动纠正，修订提交后 watcher 将自动复验。`,
        key, 'validation_failed');
      failure = { ...failure, notified: true };
    }
    return {
      summary: `head=${head} candidate=${candidate.filePath} validation_failed notified=${failure.notified === true}`,
      cursor: { ...previous, validationFailure: failure },
    };
  }
  const commit = await documentCommit(project.path, head, candidate.filePath, signal);
  const eventKey = `${head}:${candidate.filePath}:${blob}:${document.action}`;
  if (previous.eventKey === eventKey) {
    return { summary: `head=${head} candidate=${candidate.filePath} duplicate=true`, cursor: { commit: head, eventKey } };
  }
  const gate = !contract.legacy.automation_enabled
    ? 'automation_disabled'
    : candidate.type === 'PLAN'
      && [contract.documents.plan.start_action, 'await_plan_approval'].includes(document.action)
      ? 'plan_review'
      : contract.actions.executable.includes(document.action)
        ? 'execute'
        : 'terminal';
  if (mode === 'shadow' || gate === 'automation_disabled') {
    return {
      summary: `head=${head} candidate=${candidate.filePath} type=${candidate.type} action=${document.action} gate=${gate}`,
      cursor: { commit: head, eventKey },
    };
  }
  await send(project.feishu.chat_id,
    `✅ workflow validator 通过：${candidate.filePath}\ncommit: ${commit}\n${workflowContext(metadata, candidate.filePath, candidate.type)}`,
    eventKey, 'validation_passed');
  if (gate === 'terminal') {
    await send(project.feishu.chat_id,
      `[workflow-watcher] ${path.posix.basename(candidate.filePath)}: next_action=${document.action}，不启动新 Session。\n${workflowContext(metadata, candidate.filePath, candidate.type)}`,
      eventKey, 'terminal');
    return { summary: `head=${head} candidate=${candidate.filePath} action=${document.action} result=notified`, cursor: { commit: head, eventKey } };
  }
  const detectedAt = new Date().toISOString();
  const execution = {
    key: eventKey,
    prompt: document.prompt,
    workflowContext: workflowContext(metadata, candidate.filePath, candidate.type),
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
    };
    const reviewMessageId = await sendReviewCard(project, job.id, pending, sendReview);
    if (!reviewMessageId) throw new Error('plan review request returned no message_id');
    return {
      summary: `head=${head} candidate=${candidate.filePath} action=${document.action} gate=${gate} document_ready=true card_sent=true`,
      cursor: {
        commit: head,
        eventKey,
        pending: { ...pending, reviewState: 'review', reviewMessageId },
      },
    };
  }
  const started = await execute(
    execution,
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
      summary: `head=${head} candidate=${candidate.filePath} action=${document.action} gate=waiting_previous_completion`,
      cursor: previous,
    };
  }
  return {
    summary: `head=${head} candidate=${candidate.filePath} action=${document.action} result=session_started`,
    cursor: { commit: head, eventKey },
  };
};
