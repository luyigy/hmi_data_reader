import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  sendFeishuWorkflowReviewCard,
  sendFeishuWorkflowTextMessage,
} from '../feishu-api';
import {
  applyWorkflowReviewDecision,
  type WorkflowReviewPending,
} from './workflow-review';
import type { JobHandler } from './handlers';
import {
  readWorkflowContract,
  selectWorkflowCandidates,
  validateWorkflowDocument,
  workflowFrontMatter,
  type WorkflowContract,
} from './workflow-validator';

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
};

type Cursor = { commit: string; eventKey?: string; pending?: Pending };
type WorkflowRunner = (args: {
  projectId: string;
  jobId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  prompt: string;
  eventKey: string;
  signal: AbortSignal;
}) => Promise<void>;
type Message = {
  message_id?: string;
  parent_id?: string;
  msg_type?: string;
  content?: string;
  create_time?: string;
  sender?: { id?: string };
};
type WorkflowDocumentImporter = (args: {
  content: string;
  name: string;
  idempotencyKey: string;
  signal: AbortSignal;
}) => Promise<string>;
type WorkflowReviewCardSender = typeof sendFeishuWorkflowReviewCard;

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

const lark = async (signal: AbortSignal, ...args: string[]) =>
  JSON.parse(await exec('lark-cli', args, signal)) as Record<string, unknown>;

const importPlanDocument: WorkflowDocumentImporter = async ({ content, name, signal }) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-platform-plan-'));
  const file = path.join(directory, 'plan.md');
  try {
    await writeFile(file, `# ${name}\n\n${content}`);
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
  pending: Pick<Pending, 'key' | 'path' | 'documentCommit' | 'documentUrl' | 'reviewExpiresAt'>,
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
  idempotencyKey: idempotencyKey(pending.key, 'plan_review'),
});

const messages = async (chatId: string, start: string, signal: AbortSignal) => {
  const result: Message[] = [];
  let pageToken: string | undefined;
  do {
    const args = ['im', '+chat-messages-list', '--chat-id', chatId, '--as', 'bot',
      '--page-size', '50', '--order', 'asc', '--start', start, '--no-reactions'];
    if (pageToken) args.push('--page-token', pageToken);
    const data = await lark(signal, ...args);
    const payload = data.data as { messages?: Message[]; has_more?: boolean; page_token?: string } | undefined;
    result.push(...(payload?.messages ?? []));
    if (payload?.has_more && !payload.page_token) throw new Error('lark message pagination omitted page_token');
    pageToken = payload?.has_more ? payload.page_token : undefined;
  } while (pageToken);
  return result;
};

const execute = async (
  pending: Pick<Pending, 'key' | 'prompt'>,
  projectId: string,
  jobId: string,
  codingBotChatId: string,
  codingBotChatType: 'group' | 'p2p',
  runWorkflow: WorkflowRunner,
  signal: AbortSignal,
) => {
  const validationReminder = [
    '',
    '完成前必须以目标 HEAD 中的 docs/workflow/workflow-contract.yaml 为唯一规则源，',
    '对本次新增或修改的每份 PLAN/HANDOVER 运行：',
    'npm run workflow:validate -- HEAD <文档路径...>',
    '修复命令列出的全部问题并提交后，才能结束本次 Session。',
  ].join('\n');
  await runWorkflow({
    projectId,
    jobId,
    chatId: codingBotChatId,
    chatType: codingBotChatType,
    prompt: `${pending.prompt}\n${validationReminder}`,
    eventKey: pending.key,
    signal,
  });
};

export const workflowWatcherHandler = async (
  { project, job, mode, cursor, signal }: Parameters<JobHandler>[0],
  runWorkflow?: WorkflowRunner,
  importDocument: WorkflowDocumentImporter = importPlanDocument,
  sendReview: WorkflowReviewCardSender = sendFeishuWorkflowReviewCard,
) => {
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

  const head = (await git(project.path, signal, 'rev-parse', '--verify', `${project.ref}^{commit}`)).trim();
  const previous = workflowCursor(cursor, job.config.initial_cursor_commit);
  const contract = await readWorkflowContract(project.path, head, contractPath, signal);
  const ancestor = await git(project.path, signal, 'merge-base', '--is-ancestor', previous.commit, head)
    .then(() => true, () => false);
  if (!ancestor) throw new Error('configured Git ref was rewritten; human review required');
  if (contract.legacy.cutoff_commit) {
    const aboveCutoff = await git(project.path, signal, 'merge-base', '--is-ancestor', contract.legacy.cutoff_commit, previous.commit)
      .then(() => true, () => false);
    if (!aboveCutoff) throw new Error('cursor precedes contract cutoff; human review required');
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
      const revisionFeedbackMessageId = await send(
        project.feishu.chat_id,
        `<at user_id="${project.feishu.approver_open_ids[0]}"></at> 请回复本消息，说明 ${path.posix.basename(pending.path)} 需要修改的具体内容。`,
        pending.key,
        'revision_feedback_request',
      );
      pending = { ...pending, revisionFeedbackMessageId };
      return {
        summary: `head=${head} pending=${pending.path} gate=revision_feedback prompt_sent=true`,
        cursor: { ...previous, pending },
      };
    }
    if (pending.gate === 'plan_review' && pending.reviewState === 'revision_requested') {
      if (mode === 'active') {
        await execute(
          { key: pending.key, prompt: revisionPrompt() },
          project.id,
          job.id,
          codingBotChatId,
          codingBotChatType as 'group' | 'p2p',
          runWorkflow ?? (await import('../feishu-workflow')).runWorkflowInBoundLiveRoom,
          signal,
        );
      }
      pending = { ...pending, reviewState: 'revision', revisionDispatched: mode === 'active' };
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
          { key: pending.key, prompt: revisionPrompt() },
          project.id,
          job.id,
          codingBotChatId,
          codingBotChatType as 'group' | 'p2p',
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
        reviewState: undefined,
        reviewMessageId: undefined,
        reviewExpiresAt,
        detectedAt: new Date().toISOString(),
      };
      return {
        summary: `head=${head} pending=${pending.path} gate=plan_review revised=true`,
        cursor: { commit: head, eventKey: key, pending },
      };
    }
    if (pending.gate === 'plan_review') {
      if (mode === 'active' && !pending.reviewMessageId) {
        const reviewMessageId = await sendReviewCard(project, job.id, pending, sendReview);
        if (!reviewMessageId) throw new Error('plan review request returned no message_id');
        pending = { ...pending, reviewState: 'review', reviewMessageId };
        return {
          summary: `head=${head} pending=${pending.path} gate=plan_review card_sent=true`,
          cursor: { ...previous, pending },
        };
      }
      let command = '';
      if (pending.reviewState === 'review') {
        const chatMessages = mode === 'active' ? await messages(project.feishu.chat_id, pending.detectedAt, signal) : [];
        const decision = chatMessages.find((message) =>
          message.sender?.id === project.feishu.approver_open_ids[0]
          && message.msg_type === 'text'
          && message.parent_id === pending.reviewMessageId
          && /^(approve|reject|revise:\s*\S[\s\S]*)$/.test(message.content?.trim() ?? ''));
        command = decision?.content?.trim() ?? '';
        if (!decision) {
          return { summary: `head=${head} pending=${pending.path} gate=plan_review`, cursor: previous };
        }
        const transition = applyWorkflowReviewDecision({
          pending,
          decision: command === 'approve' ? 'approve' : command === 'reject' ? 'reject' : 'revision',
          actorOpenId: decision.sender?.id,
          approverOpenId: project.feishu.approver_open_ids[0],
          messageId: decision.parent_id,
          pendingKey: pending.key,
          reviewFeedback: command.slice(7).trim(),
        });
        if (transition.status !== 'applied') {
          return { summary: `head=${head} pending=${pending.path} gate=plan_review decision=${transition.status}`, cursor: previous };
        }
        pending = { ...pending, ...transition.pending };
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
      await execute(
        pending,
        project.id,
        job.id,
        codingBotChatId,
        codingBotChatType as 'group' | 'p2p',
        runWorkflow ?? (await import('../feishu-workflow')).runWorkflowInBoundLiveRoom,
        signal,
      );
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

  const content = await git(project.path, signal, 'show', `${head}:${candidate.filePath}`);
  const metadata = workflowFrontMatter(content);
  const document = await validateWorkflowDocument(
    project.path, head, candidate.filePath, candidate.type, content, metadata, contract, watchRoot, signal,
  );
  const blob = (await git(project.path, signal, 'rev-parse', `${head}:${candidate.filePath}`)).trim();
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
  if (gate === 'terminal') {
    await send(project.feishu.chat_id,
      `[workflow-watcher] ${path.posix.basename(candidate.filePath)}: next_action=${document.action}，不启动新 Session。`,
      eventKey, 'terminal');
    return { summary: `head=${head} candidate=${candidate.filePath} action=${document.action} result=notified`, cursor: { commit: head, eventKey } };
  }
  const detectedAt = new Date().toISOString();
  const execution = {
    key: eventKey,
    prompt: document.prompt,
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
      reviewExpiresAt: reviewExpiry(contract),
      detectedAt,
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
  await execute(
    execution,
    project.id,
    job.id,
    codingBotChatId,
    codingBotChatType as 'group' | 'p2p',
    runWorkflow ?? (await import('../feishu-workflow')).runWorkflowInBoundLiveRoom,
    signal,
  );
  return {
    summary: `head=${head} candidate=${candidate.filePath} action=${document.action} result=session_started`,
    cursor: { commit: head, eventKey },
  };
};
