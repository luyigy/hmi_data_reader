import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { parse } from 'yaml';
import {
  sendFeishuWorkflowReviewCard,
  sendFeishuWorkflowTextMessage,
} from '../feishu-api';
import {
  applyWorkflowReviewDecision,
  type WorkflowReviewPending,
} from './workflow-review';
import type { JobHandler } from './handlers';

type Contract = {
  schema_version: number;
  documents: {
    automation_types: string[];
    filename_pattern: string;
    slice_pattern: string;
    statuses: string[];
    common_required_fields: string[];
    plan: {
      required_fields: string[];
      kinds: string[];
      executable_actions: string[];
      start_action: string;
      start_status: string;
      interrupt_kind: string;
      phase_kind: string;
      parent_fields: string[];
    };
    handover: {
      required_fields: string[];
      progress_values: string[];
      executable_actions: string[];
      next_action: string;
      resume_action: string;
    };
  };
  actions: { executable: string[]; terminal: string[] };
  prompt: { start_marker: string; end_marker: string };
  completion_gate: { timeout_seconds: number };
  branch_spaces: { root: string };
  numbering: { width: number; unique: boolean; candidate_selection: string };
  legacy: { cutoff_commit?: string | null; automation_enabled: boolean };
};

type Pending = WorkflowReviewPending & {
  key: string;
  commit: string;
  path: string;
  blob: string;
  action: string;
  type: string;
  documentCommit: string;
  prompt: string;
  detectedAt: string;
  reviewExpiresAt?: string;
};

type Cursor = { commit: string; eventKey?: string; pending?: Pending };
type WorkflowRunner = (args: {
  chatId: string;
  chatType: 'group' | 'p2p';
  prompt: string;
  eventKey: string;
}) => Promise<void>;
type Message = {
  message_id?: string;
  parent_id?: string;
  msg_type?: string;
  content?: string;
  create_time?: string;
  sender?: { id?: string };
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

const required = <T>(value: T | undefined | null, label: string): T => {
  if (value === undefined || value === null) throw new Error(`workflow contract missing ${label}`);
  return value;
};

const strings = (value: unknown, label: string) => {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string' || !item)) {
    throw new Error(`workflow contract has invalid ${label}`);
  }
  return value as string[];
};

const readContract = async (
  cwd: string,
  head: string,
  contractPath: string,
  signal: AbortSignal,
) => {
  const source = await git(cwd, signal, 'show', `${head}:${contractPath}`);
  const contract = parse(source) as Contract;
  if (contract.schema_version !== 2) throw new Error(`unsupported workflow schema_version: ${contract.schema_version}`);
  strings(contract.documents?.automation_types, 'documents.automation_types');
  required(contract.documents?.filename_pattern, 'documents.filename_pattern');
  required(contract.documents?.slice_pattern, 'documents.slice_pattern');
  strings(contract.documents?.statuses, 'documents.statuses');
  strings(contract.documents?.common_required_fields, 'documents.common_required_fields');
  strings(contract.documents?.plan?.required_fields, 'documents.plan.required_fields');
  strings(contract.documents?.plan?.kinds, 'documents.plan.kinds');
  strings(contract.documents?.plan?.parent_fields, 'documents.plan.parent_fields');
  strings(contract.documents?.handover?.required_fields, 'documents.handover.required_fields');
  strings(contract.documents?.handover?.progress_values, 'documents.handover.progress_values');
  const executable = strings(contract.actions?.executable, 'actions.executable');
  const terminal = strings(contract.actions?.terminal, 'actions.terminal');
  if (executable.some((action) => terminal.includes(action))) throw new Error('workflow action sets overlap');
  const planActions = strings(contract.documents.plan.executable_actions, 'documents.plan.executable_actions');
  const handoverActions = strings(contract.documents.handover.executable_actions, 'documents.handover.executable_actions');
  if ([...planActions, ...handoverActions].sort().join() !== [...executable].sort().join()) {
    throw new Error('document executable actions do not match actions.executable');
  }
  if (planActions.length !== 1 || planActions[0] !== contract.documents.plan.start_action) {
    throw new Error('PLAN executable actions do not match plan.start_action');
  }
  if ([contract.documents.handover.next_action, contract.documents.handover.resume_action].sort().join()
    !== [...handoverActions].sort().join()) {
    throw new Error('HANDOVER executable actions do not match next_action/resume_action');
  }
  required(contract.prompt?.start_marker, 'prompt.start_marker');
  required(contract.prompt?.end_marker, 'prompt.end_marker');
  if (!Number.isInteger(contract.completion_gate?.timeout_seconds)
    || contract.completion_gate.timeout_seconds <= 0) throw new Error('workflow contract has invalid completion_gate');
  required(contract.branch_spaces?.root, 'branch_spaces.root');
  required(contract.numbering?.width, 'numbering.width');
  required(contract.legacy?.automation_enabled, 'legacy.automation_enabled');
  if (contract.numbering.candidate_selection !== 'highest_changed_number') {
    throw new Error(`unsupported candidate_selection: ${contract.numbering.candidate_selection}`);
  }
  return contract;
};

const frontMatter = (content: string) => {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error('missing YAML front matter');
  const metadata = parse(match[1]);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('workflow front matter must be a mapping');
  }
  return metadata as Record<string, unknown>;
};

const workflowCursor = (cursor: unknown, initialCommit: unknown): Cursor => {
  if (cursor && typeof cursor === 'object' && 'commit' in cursor && typeof cursor.commit === 'string') {
    return cursor as Cursor;
  }
  if (typeof initialCommit !== 'string' || !initialCommit) {
    throw new Error('workflow_watcher requires config.initial_cursor_commit for first run');
  }
  return { commit: initialCommit };
};

const normalizeReference = (value: unknown, watchRoot: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('document reference is empty');
  const reference = value.replace(/^\.\//, '');
  const resolved = reference.includes('/') ? reference : path.posix.join(watchRoot, reference);
  if (path.posix.dirname(resolved) !== watchRoot || resolved.split('/').includes('..')) {
    throw new Error(`reference leaves workflow directory: ${value}`);
  }
  return resolved;
};

const promptFrom = (content: string, action: string, contract: Contract) => {
  const { start_marker: start, end_marker: end } = contract.prompt;
  const starts = content.split(start).length - 1;
  const ends = content.split(end).length - 1;
  if (!contract.actions.executable.includes(action)) {
    if (starts || ends) throw new Error(`${action} must not contain an automation prompt`);
    return '';
  }
  if (starts !== 1 || ends !== 1) throw new Error('executable action requires exactly one prompt marker pair');
  const prompt = content.slice(content.indexOf(start) + start.length, content.indexOf(end)).trim();
  if (!prompt) throw new Error('automation prompt is empty');
  return prompt;
};

const documentCommit = async (cwd: string, head: string, filePath: string, signal: AbortSignal) => {
  const commit = (await git(cwd, signal, 'log', '-1', '--format=%H', head, '--', filePath)).trim();
  if (!commit) throw new Error(`cannot resolve document commit: ${filePath}`);
  return commit;
};

const exists = (cwd: string, head: string, filePath: string, signal: AbortSignal) =>
  git(cwd, signal, 'cat-file', '-e', `${head}:${filePath}`).then(() => true, () => false);

const slices = (content: string, contract: Contract) =>
  Array.from(new Set(content.match(new RegExp(contract.documents.slice_pattern, 'g')) ?? []))
    .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));

const validateDocument = async (
  cwd: string,
  head: string,
  filePath: string,
  type: string,
  content: string,
  metadata: Record<string, unknown>,
  contract: Contract,
  watchRoot: string,
  signal: AbortSignal,
) => {
  for (const field of contract.documents.common_required_fields) required(metadata[field], field);
  if (metadata.doc_type !== type) throw new Error('filename type and doc_type differ');
  if (!contract.documents.statuses.includes(String(metadata.doc_status))) throw new Error(`invalid doc_status: ${metadata.doc_status}`);
  const action = String(metadata.next_action);
  if (![...contract.actions.executable, ...contract.actions.terminal].includes(action)) {
    throw new Error(`invalid next_action: ${action}`);
  }
  const prompt = promptFrom(content, action, contract);
  const requirePromptRefs = (...refs: string[]) => refs.forEach((ref) => {
    if (prompt && !prompt.includes(ref) && !prompt.includes(path.posix.basename(ref))) {
      throw new Error(`automation prompt does not name ${path.posix.basename(ref)}`);
    }
  });
  const readPlan = async (reference: unknown) => {
    const planPath = normalizeReference(reference, watchRoot);
    if (!await exists(cwd, head, planPath, signal)) throw new Error(`referenced PLAN does not exist: ${path.posix.basename(planPath)}`);
    const planContent = await git(cwd, signal, 'show', `${head}:${planPath}`);
    const planMetadata = frontMatter(planContent);
    if (planMetadata.doc_type !== 'PLAN') throw new Error(`referenced document is not a PLAN: ${path.posix.basename(planPath)}`);
    return { planPath, planContent, planMetadata };
  };

  if (type === 'PLAN') {
    contract.documents.plan.required_fields.forEach((field) => {
      if (!(field in metadata)) throw new Error(`PLAN missing YAML field: ${field}`);
    });
    if (contract.actions.executable.includes(action) && !contract.documents.plan.executable_actions.includes(action)) {
      throw new Error(`PLAN cannot execute ${action}`);
    }
    if (action === contract.documents.plan.start_action && metadata.doc_status !== contract.documents.plan.start_status) {
      throw new Error(`${action} requires doc_status ${contract.documents.plan.start_status}`);
    }
    const roadmap = normalizeReference(metadata.roadmap, watchRoot);
    if (!await exists(cwd, head, roadmap, signal)) throw new Error(`referenced ROADMAP does not exist: ${path.posix.basename(roadmap)}`);
    if (!contract.documents.plan.kinds.includes(String(metadata.plan_kind))) throw new Error(`invalid plan_kind: ${metadata.plan_kind}`);
    if (metadata.plan_kind === contract.documents.plan.interrupt_kind) {
      contract.documents.plan.parent_fields.forEach((field) => required(metadata[field], field));
      const parent = await readPlan(metadata.parent_plan);
      if (!slices(parent.planContent, contract).includes(String(metadata.parent_slice))
        || !slices(parent.planContent, contract).includes(String(metadata.return_to))) {
        throw new Error('parent_slice or return_to is absent from parent PLAN');
      }
    } else if (metadata.plan_kind === contract.documents.plan.phase_kind
      && contract.documents.plan.parent_fields.some((field) => metadata[field] !== null)) {
      throw new Error('phase PLAN parent fields must be null');
    }
    const planSlices = slices(content, contract);
    if (prompt && (!planSlices.length || !prompt.includes(planSlices[0]))) throw new Error('start prompt does not name the first Slice');
    requirePromptRefs(filePath, roadmap);
  } else {
    contract.documents.handover.required_fields.forEach((field) => {
      if (!(field in metadata)) throw new Error(`HANDOVER missing YAML field: ${field}`);
    });
    if (!contract.documents.handover.progress_values.includes(String(metadata.plan_progress))) {
      throw new Error(`invalid plan_progress: ${metadata.plan_progress}`);
    }
    if (contract.actions.executable.includes(action) && !contract.documents.handover.executable_actions.includes(action)) {
      throw new Error(`HANDOVER cannot execute ${action}`);
    }
    if (metadata.plan === null) {
      if (contract.actions.executable.includes(action)) throw new Error('standalone HANDOVER cannot start a session');
    } else {
      const plan = await readPlan(metadata.plan);
      const planSlices = slices(plan.planContent, contract);
      if (!planSlices.includes(String(metadata.slice))) throw new Error('HANDOVER slice is absent from owning PLAN');
      if (prompt) {
        const roadmap = normalizeReference(plan.planMetadata.roadmap, watchRoot);
        requirePromptRefs(filePath, plan.planPath, roadmap);
        if (action === contract.documents.handover.next_action) {
          const current = planSlices.indexOf(String(metadata.slice));
          if (current + 1 >= planSlices.length || !prompt.includes(planSlices[current + 1])) {
            throw new Error('next action prompt does not name the next Slice');
          }
        } else if (action === contract.documents.handover.resume_action) {
          if (plan.planMetadata.plan_kind !== contract.documents.plan.interrupt_kind) {
            throw new Error('resume action requires an interrupt PLAN');
          }
          const parent = await readPlan(plan.planMetadata.parent_plan);
          const returnTo = String(plan.planMetadata.return_to);
          if (!slices(parent.planContent, contract).includes(returnTo) || !prompt.includes(returnTo)) {
            throw new Error('resume prompt does not name valid return_to');
          }
          requirePromptRefs(parent.planPath);
        }
      }
    }
  }
  return { action, prompt };
};

const idempotencyKey = (eventKey: string, step: string) =>
  createHash('sha256').update(`${eventKey}:${step}`).digest('hex').slice(0, 32);

const lark = async (signal: AbortSignal, ...args: string[]) =>
  JSON.parse(await exec('lark-cli', args, signal)) as Record<string, unknown>;

const send = (chatId: string, text: string, eventKey: string, step: string) =>
  sendFeishuWorkflowTextMessage({
    chatId,
    text,
    idempotencyKey: idempotencyKey(eventKey, step),
  });

const reviewExpiry = (contract: Contract) =>
  new Date(Date.now() + contract.completion_gate.timeout_seconds * 1000).toISOString();

const sendReviewCard = (
  project: Parameters<JobHandler>[0]['project'],
  jobId: string,
  pending: Pick<Pending, 'key' | 'path' | 'documentCommit' | 'reviewExpiresAt'>,
) => sendFeishuWorkflowReviewCard({
  chatId: project.feishu.chat_id,
  projectId: project.id,
  jobId,
  pendingKey: pending.key,
  approverOpenId: project.feishu.approver_open_ids[0],
  planPath: pending.path,
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
  codingBotChatId: string,
  codingBotChatType: 'group' | 'p2p',
  runWorkflow: WorkflowRunner,
) => {
  await runWorkflow({
    chatId: codingBotChatId,
    chatType: codingBotChatType,
    prompt: pending.prompt,
    eventKey: pending.key,
  });
};

export const workflowWatcherHandler = async (
  { project, job, mode, cursor, signal }: Parameters<JobHandler>[0],
  runWorkflow?: WorkflowRunner,
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
  const contract = await readContract(project.path, head, contractPath, signal);
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
    if (pending.gate === 'plan_review' && pending.reviewState === 'revision') {
      const content = await git(project.path, signal, 'show', `${head}:${pending.path}`);
      const blob = (await git(project.path, signal, 'rev-parse', `${head}:${pending.path}`)).trim();
      if (blob === pending.blob) {
        return { summary: `head=${head} pending=${pending.path} gate=plan_revision`, cursor: previous };
      }
      const metadata = frontMatter(content);
      const revised = await validateDocument(
        project.path, head, pending.path, 'PLAN', content, metadata, contract,
        path.posix.dirname(pending.path), signal,
      );
      if (revised.action !== contract.documents.plan.start_action) {
        throw new Error('revised document is not an executable PLAN');
      }
      const commit = await documentCommit(project.path, head, pending.path, signal);
      const key = `${head}:${pending.path}:${blob}:${revised.action}`;
      const reviewExpiresAt = reviewExpiry(contract);
      const reviewMessageId = mode === 'active' ? await sendReviewCard(project, job.id, {
        key,
        path: pending.path,
        documentCommit: commit,
        reviewExpiresAt,
      }) : undefined;
      if (mode === 'active' && !reviewMessageId) throw new Error('plan review request returned no message_id');
      pending = {
        ...pending,
        key,
        commit,
        blob,
        documentCommit: commit,
        prompt: revised.prompt,
        reviewState: 'review',
        reviewMessageId,
        reviewExpiresAt,
        detectedAt: new Date().toISOString(),
      };
      return {
        summary: `head=${head} pending=${pending.path} gate=plan_review revised=true`,
        cursor: { commit: head, eventKey: key, pending },
      };
    }
    if (pending.gate === 'plan_review') {
      const chatMessages = mode === 'active' ? await messages(project.feishu.chat_id, pending.detectedAt, signal) : [];
      let command = '';
      if (pending.reviewState === 'review') {
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
        });
        if (transition.status !== 'applied') {
          return { summary: `head=${head} pending=${pending.path} gate=plan_review decision=${transition.status}`, cursor: previous };
        }
        pending = { ...pending, ...transition.pending };
      }
      if (pending.reviewState !== 'approved') {
        if (pending.reviewState === 'revision') {
          await send(codingBotChatId,
            `PLAN_REVISE\nplan_path: ${pending.path}\n`
            + `reviewed_commit: ${pending.documentCommit}\nfeedback:\n${command.slice(7).trim()}\n\n`
            + '只修订并提交该 PLAN，不执行任何 Slice。',
            pending.key, 'plan_revision');
        }
        return {
          summary: `head=${head} pending=${pending.path} gate=plan_revision decision=${pending.reviewState === 'rejected' ? 'reject' : 'revise'}`,
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
        codingBotChatId,
        codingBotChatType as 'group' | 'p2p',
        runWorkflow ?? (await import('../feishu-workflow')).runWorkflowInBoundLiveRoom,
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
  const filename = new RegExp(contract.documents.filename_pattern.replace(/\(\?P<[^>]+>/g, '('));
  const candidates = changed.flatMap((filePath) => {
    const match = filename.exec(path.posix.basename(filePath));
    if (!match || path.posix.dirname(filePath) !== watchRoot || !contract.documents.automation_types.includes(match[2])) return [];
    return [{ filePath, number: Number(match[1]), rawNumber: match[1], type: match[2] }];
  }).sort((left, right) => left.number - right.number || left.filePath.localeCompare(right.filePath));

  if (!candidates.length) return { summary: `head=${head} candidate=none`, cursor: { commit: head, eventKey: previous.eventKey } };
  const candidate = candidates.at(-1)!;
  if (candidate.rawNumber.length !== contract.numbering.width) throw new Error('workflow document number has invalid width');
  if (contract.numbering.unique && candidates.filter((item) => item.number === candidate.number).length !== 1) {
    throw new Error(`multiple workflow documents use number ${candidate.number}`);
  }

  const content = await git(project.path, signal, 'show', `${head}:${candidate.filePath}`);
  const metadata = frontMatter(content);
  const document = await validateDocument(
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
    const pending: Pending = {
      ...execution,
      commit,
      path: candidate.filePath,
      blob,
      action: document.action,
      type: candidate.type,
      documentCommit: commit,
      gate,
      reviewState: 'review',
      reviewExpiresAt: reviewExpiry(contract),
      detectedAt,
    };
    pending.reviewMessageId = await sendReviewCard(project, job.id, pending);
    if (!pending.reviewMessageId) throw new Error('plan review request returned no message_id');
    return {
      summary: `head=${head} candidate=${candidate.filePath} action=${document.action} gate=${gate} pending=true`,
      cursor: { commit: head, eventKey, pending },
    };
  }
  await execute(
    execution,
    codingBotChatId,
    codingBotChatType as 'group' | 'p2p',
    runWorkflow ?? (await import('../feishu-workflow')).runWorkflowInBoundLiveRoom,
  );
  return {
    summary: `head=${head} candidate=${candidate.filePath} action=${document.action} result=session_started`,
    cursor: { commit: head, eventKey },
  };
};
