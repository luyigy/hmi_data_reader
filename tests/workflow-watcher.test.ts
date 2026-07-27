import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workflowWatcherHandler } from '../src/lib/scheduled-jobs/workflow-watcher';
import {
  applyWorkflowReviewDecision,
  applyWorkflowRevisionFeedback,
} from '../src/lib/scheduled-jobs/workflow-review';
import type { JobConfig, ProjectConfig } from '../src/lib/scheduled-jobs/project-config';

async function main() {
  process.env.FEISHU_APP_ID = 'local-ai-assistant';
  process.env.FEISHU_APP_SECRET = 'local-secret';
  const apiCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  global.fetch = (async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    if (url.includes('/tenant_access_token/')) {
      assert.equal(body.app_id, 'local-ai-assistant');
      return { ok: true, status: 200, json: async () => ({ code: 0, tenant_access_token: 'token', expire: 3600 }) };
    }
    apiCalls.push({ url, body });
    if (process.env.LARK_FAIL_PROMPT === '1' && String(body.content).includes('NEXT PROMPT')) {
      return { ok: false, status: 500, json: async () => ({ code: 1, msg: 'prompt-failed' }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        data: { message_id: body.msg_type === 'interactive' ? 'review-1' : 'sent-1' },
      }),
    };
  }) as typeof fetch;

  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-watcher-'));
  const bin = path.join(root, 'bin');
  const messagesFile = path.join(root, 'messages.json');
  const callsFile = path.join(root, 'calls.log');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await mkdir(path.join(root, 'docs/workflow'), { recursive: true });
  await mkdir(path.join(root, 'docs/branch/main'), { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(bin, 'lark-cli'), `#!/bin/sh
if [ "$2" = "+chat-messages-list" ]; then
  [ "$LARK_FAIL_MESSAGES" = 1 ] && { echo messages-forbidden >&2; exit 1; }
  exec /bin/cat "$LARK_MESSAGES_FILE"
fi
printf '%s\\n' "$*" >> "$LARK_CALLS_FILE"
case "$*" in
  *"NEXT PROMPT"*) [ "$LARK_FAIL_PROMPT" = 1 ] && { echo prompt-failed >&2; exit 1; };;
esac
case "$*" in
  "docs +create --as bot --api-version v2 --doc-format markdown --content @plan.md --format json")
    grep -q '^# 005_PLAN_20260725_import_failure$' plan.md || exit 1
    echo '{"ok":true,"identity":"user","data":{"document":{"url":"https://example.feishu.cn/docx/default-import"}}}'
    ;;
  *PLAN_REVIEW*) echo '{"data":{"message_id":"review-1"}}';;
  *) echo '{"data":{"message_id":"sent-1"}}';;
esac
`);
  await chmod(path.join(bin, 'lark-cli'), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.LARK_MESSAGES_FILE = messagesFile;
  process.env.LARK_CALLS_FILE = callsFile;
  await writeFile(messagesFile, '{"data":{"messages":[],"has_more":false}}');
  await writeFile(callsFile, '');

  await writeFile(path.join(root, 'docs/workflow/workflow-contract.yaml'), `
schema_version: 2
contract_version: test
documents:
  automation_types: [PLAN, HANDOVER]
  filename_pattern: "^(?P<number>[0-9]+)_(?P<doc_type>[A-Z]+)_(?P<date>[0-9]{8})_.+\\\\.md$"
  slice_pattern: "\\\\bS[0-9]{2,}\\\\b"
  statuses: [draft, ready, completed]
  common_required_fields: [doc_type, doc_status, next_action]
  plan:
    required_fields: [plan_kind, roadmap, parent_plan, parent_slice, return_to]
    required_fields_by_kind:
      interrupt: [parent_plan, parent_slice, return_to]
    kinds: [phase, interrupt]
    executable_actions: [start_first_slice]
    start_action: start_first_slice
    start_status: ready
    interrupt_kind: interrupt
    phase_kind: phase
    parent_fields: [parent_plan, parent_slice, return_to]
  handover:
    required_fields: [plan, slice, plan_progress]
    progress_values: [in_progress, complete]
    executable_actions: [next_slice, resume_parent]
    next_action: next_slice
    resume_action: resume_parent
actions:
  executable: [start_first_slice, next_slice, resume_parent]
  terminal: [await_plan_approval, await_acceptance, blocked, none]
prompt:
  start_marker: "<!-- WORKFLOW_PROMPT_START -->"
  end_marker: "<!-- WORKFLOW_PROMPT_END -->"
completion_gate:
  timeout_seconds: 1800
branch_spaces:
  root: docs/branch
numbering:
  width: 3
  unique: true
  candidate_selection: highest_changed_number
legacy:
  cutoff_commit: null
  automation_enabled: true
`);
  await writeFile(path.join(root, 'docs/branch/main/000_ROADMAP_20260725_test.md'), '# roadmap\n');
  await writeFile(path.join(root, 'docs/branch/main/000_PLAN_20260725_owner.md'), `---
doc_type: PLAN
doc_status: ready
next_action: none
plan_kind: phase
roadmap: 000_ROADMAP_20260725_test.md
parent_plan: null
parent_slice: null
return_to: null
---
S01 then S02
`);
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');

  const job: JobConfig = {
    id: 'workflow-watcher',
    type: 'workflow_watcher',
    schedule: '*/10 * * * *',
    enabled: true,
    mode: 'active',
    config: {
      contract_path: 'docs/workflow/workflow-contract.yaml',
      branch_space: 'main',
      initial_cursor_commit: base,
      active_side_effects_enabled: true,
      coding_bot_chat_id: 'coding-bot-chat',
      coding_bot_chat_type: 'group',
      coding_bot_app_id: 'coding-app',
    },
  };
  const project: ProjectConfig = {
    id: 'example',
    name: 'Example',
    path: root,
    ref: 'refs/heads/main',
    feishu: { chat_id: 'chat', approver_open_ids: ['approver'] },
    jobs: [job],
  };
  const workflowRuns: Array<{ chatId: string; chatType: 'group' | 'p2p'; prompt: string; eventKey: string }> = [];
  const importedDocuments: Array<{ content: string; name: string; idempotencyKey: string }> = [];
  const importDocument = async (args: {
    content: string;
    name: string;
    idempotencyKey: string;
    signal: AbortSignal;
  }) => {
    assert(!args.signal.aborted);
    importedDocuments.push(args);
    return `https://example.feishu.cn/docx/${args.idempotencyKey}`;
  };
  const run = (cursor?: unknown, mode: 'shadow' | 'active' = 'active') => workflowWatcherHandler({
    project,
    job,
    mode,
    cursor,
    signal: new AbortController().signal,
  }, async (args) => {
    workflowRuns.push(args);
    if (process.env.LARK_FAIL_PROMPT === '1') throw new Error('prompt-failed');
  }, importDocument);

  assert.match((await run(undefined, 'shadow')).summary, /candidate=none/);
  job.config.active_side_effects_enabled = false;
  await assert.rejects(run(undefined, 'active'), /active side effects require explicit config gate/);
  job.config.active_side_effects_enabled = true;

  await writeFile(path.join(root, 'docs/branch/000_ROADMAP_20260725_root.md'), '# roadmap\n');
  await writeFile(path.join(root, 'docs/branch/000_PLAN_20260725_root.md'), `---
doc_type: PLAN
doc_status: ready
next_action: none
plan_kind: phase
roadmap: 000_ROADMAP_20260725_root.md
parent_plan: null
parent_slice: null
return_to: null
---
S01
`);
  await writeFile(path.join(root, 'docs/branch/001_HANDOVER_20260725_root.md'), `---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: 000_PLAN_20260725_root.md
slice: S01
plan_progress: complete
---
`);
  git('add', '.');
  git('commit', '-qm', 'root branch-space handover');
  const missed = await run();
  assert.match(missed.summary, /candidate=none/);
  job.config.branch_space = '.';
  assert.match((await run(missed.cursor)).summary, /001_HANDOVER_20260725_root.md.*result=notified/);
  job.config.branch_space = 'main';
  await writeFile(callsFile, '');

  await writeFile(path.join(root, 'docs/branch/main/001_HANDOVER_20260725_test.md'), `---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: 000_PLAN_20260725_owner.md
slice: S01
plan_progress: in_progress
---
<!-- WORKFLOW_PROMPT_START -->
NEXT PROMPT 001_HANDOVER_20260725_test.md 000_PLAN_20260725_owner.md 000_ROADMAP_20260725_test.md S02
<!-- WORKFLOW_PROMPT_END -->
`);
  git('add', '.');
  git('commit', '-qm', 'handover');
  process.env.LARK_FAIL_PROMPT = '1';
  await assert.rejects(run(), /prompt-failed/);

  process.env.LARK_FAIL_PROMPT = '0';
  const completed = await run();
  assert.match(completed.summary, /result=session_started/);
  assert.equal(workflowRuns.length, 2);
  assert.deepEqual(workflowRuns[0], workflowRuns[1], 'workflow retry must reuse the same event key and prompt');
  assert.equal(workflowRuns[0].chatId, 'coding-bot-chat');
  assert.equal(workflowRuns[0].chatType, 'group');
  assert.match(workflowRuns[0].prompt, /NEXT PROMPT/);
  assert.match(workflowRuns[0].prompt, /npm run workflow:validate -- HEAD <文档路径\.\.\.>/);
  const unchanged = await run(completed.cursor);
  assert.match(unchanged.summary, /candidate=none/);
  assert.equal((unchanged.cursor as { eventKey?: string }).eventKey, (completed.cursor as { eventKey?: string }).eventKey);

  await writeFile(path.join(root, 'docs/branch/main/002_HANDOVER_20260725_terminal.md'), `---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: 000_PLAN_20260725_owner.md
slice: S02
plan_progress: complete
---
`);
  git('add', '.');
  git('commit', '-qm', 'terminal');
  const terminal = await run(completed.cursor);
  assert.match(terminal.summary, /result=notified/);
  assert.match((await run(terminal.cursor)).summary, /candidate=none/);

  await writeFile(path.join(root, 'docs/branch/main/003_PLAN_20260725_review.md'), `---
doc_type: PLAN
doc_status: ready
next_action: start_first_slice
plan_kind: phase
roadmap: 000_ROADMAP_20260725_test.md
parent_plan: null
parent_slice: null
return_to: null
---
此前阶段 S08 已完成。
S01
<!-- WORKFLOW_PROMPT_START -->
PLAN PROMPT 003_PLAN_20260725_review.md 000_ROADMAP_20260725_test.md S01
<!-- WORKFLOW_PROMPT_END -->
`);
  git('add', '.');
  git('commit', '-qm', 'plan review');
  const review = await run(terminal.cursor);
  assert.match(review.summary, /gate=plan_review document_ready=true card_sent=true/);
  const reviewCursor = review.cursor as { pending: {
    detectedAt: string;
    reviewMessageId: string;
    reviewExpiresAt: string;
    documentUrl: string;
  } };
  const reviewCall = apiCalls.filter(({ body }) => body.msg_type === 'interactive').at(-1);
  assert.ok(reviewCall);
  assert.match(String(reviewCall.body.content), /批准/);
  assert.match(String(reviewCall.body.content), /拒绝/);
  assert.match(String(reviewCall.body.content), /修改/);
  assert.match(String(reviewCall.body.content), /"decision":"revision"/);
  assert.match(String(reviewCall.body.content), /reviewFeedback/);
  assert.match(String(reviewCall.body.content), /"tag":"form"/);
  assert.match(String(reviewCall.body.content), /"action_type":"form_submit"/);
  assert.match(String(reviewCall.body.content), new RegExp(reviewCursor.pending.documentUrl));
  assert.equal(importedDocuments.length, 1);
  assert.match(importedDocuments[0].content, /PLAN PROMPT/);
  assert.equal(new URL(reviewCall.url).searchParams.get('receive_id_type'), 'chat_id');

  const undispatchedRevisionCursor = JSON.parse(JSON.stringify(reviewCursor));
  undispatchedRevisionCursor.pending.reviewState = 'revision';
  undispatchedRevisionCursor.pending.reviewFeedback = '';
  undispatchedRevisionCursor.pending.revisionDispatchKey = 'revision-key:retry:request-1';
  const recoveredRevision = await run(undispatchedRevisionCursor);
  assert.match(recoveredRevision.summary, /dispatch_recovered=true/);
  assert.equal(
    (recoveredRevision.cursor as { pending: { revisionDispatched: boolean } }).pending.revisionDispatched,
    true,
  );
  assert.equal(workflowRuns.at(-1)?.eventKey, 'revision-key:retry:request-1');
  assert.match(workflowRuns.at(-1)?.prompt ?? '', /请先主动询问审批人需要修改的内容/);

  await writeFile(path.join(root, 'docs/branch/main/003_PLAN_20260725_review.md'),
    `${importedDocuments[0].content}\n修订内容\n`);
  git('add', '.');
  git('commit', '-qm', 'revise plan');
  const revisionCursor = JSON.parse(JSON.stringify(reviewCursor));
  revisionCursor.pending.reviewState = 'revision';
  const revisedDocument = await run(revisionCursor);
  assert.match(revisedDocument.summary, /gate=plan_review revised=true/);
  assert.equal(importedDocuments.length, 2);
  assert.notEqual(
    (revisedDocument.cursor as { pending: { documentUrl: string } }).pending.documentUrl,
    reviewCursor.pending.documentUrl,
  );
  const revisedReview = await run(revisedDocument.cursor);
  assert.match(revisedReview.summary, /gate=plan_review card_sent=true/);
  const revisedCall = apiCalls.filter(({ body }) => body.msg_type === 'interactive').at(-1);
  assert.match(String(revisedCall?.body.content),
    new RegExp((revisedReview.cursor as { pending: { documentUrl: string } }).pending.documentUrl));

  const revisionRequestCursor = JSON.parse(JSON.stringify(revisedReview.cursor));
  revisionRequestCursor.pending.reviewState = 'revision_requested';
  revisionRequestCursor.pending.reviewFeedback = '请补充风险和验收步骤。';
  const revisionRequestedRun = await run(revisionRequestCursor);
  assert.match(revisionRequestedRun.summary, /gate=plan_revision decision=revise/);
  assert.equal(
    (revisionRequestedRun.cursor as { pending: { reviewState: string } }).pending.reviewState,
    'revision',
  );
  assert.match(
    workflowRuns.at(-1)?.prompt ?? '',
    /请补充风险和验收步骤/,
  );
  const emptyRevisionRequestCursor = JSON.parse(JSON.stringify(revisedReview.cursor));
  emptyRevisionRequestCursor.pending.reviewState = 'awaiting_revision_feedback';
  emptyRevisionRequestCursor.pending.reviewFeedback = '';
  const workflowRunCount = workflowRuns.length;
  const waitingForFeedback = await run(emptyRevisionRequestCursor);
  assert.match(waitingForFeedback.summary, /gate=revision_feedback prompt_sent=true/);
  assert.equal(workflowRuns.length, workflowRunCount, 'empty feedback must not start Coding Agent');
  const feedbackCard = apiCalls.filter(({ body }) => body.msg_type === 'interactive').at(-1);
  assert.match(String(feedbackCard?.body.content), /workflow-revision-feedback/);
  assert.match(String(feedbackCard?.body.content), /"required":true/);
  assert.match(String(feedbackCard?.body.content), /"input_type":"multiline_text"/);
  assert.equal(
    (waitingForFeedback.cursor as { pending: { revisionFeedbackMessageId: string } })
      .pending.revisionFeedbackMessageId,
    'review-1',
  );

  git('commit', '--allow-empty', '-qm', 'unrelated head advance');
  await writeFile(messagesFile, JSON.stringify({ data: { has_more: false, messages: [
    { sender: { id: 'coding-app' }, msg_type: 'text', content: '✅ 已为全部 4 个 agent 重置 session' },
  ] } }));
  const revisedReviewCursor = revisedReview.cursor as typeof reviewCursor;
  const callbackApproved = JSON.parse(JSON.stringify(revisedReviewCursor));
  callbackApproved.pending.reviewState = 'approved';
  job.config.coding_bot_chat_type = 'p2p';
  process.env.LARK_FAIL_MESSAGES = '1';
  assert.match((await run(callbackApproved)).summary, /result=session_started/);
  process.env.LARK_FAIL_MESSAGES = '0';
  assert.equal(workflowRuns.at(-1)?.chatId, 'coding-bot-chat');
  assert.equal(workflowRuns.at(-1)?.chatType, 'p2p');

  const callbackRejected = JSON.parse(JSON.stringify(revisedReviewCursor));
  callbackRejected.pending.reviewState = 'rejected';
  const rejected = await run(callbackRejected);
  assert.match(rejected.summary, /result=rejected/);
  assert.deepEqual(rejected.cursor, {
    commit: callbackRejected.pending.commit,
    eventKey: callbackRejected.pending.key,
  });

  const reviewPending = {
    key: 'key',
    gate: 'plan_review' as const,
    reviewState: 'review' as const,
    reviewMessageId: 'message',
    reviewExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  assert.equal(applyWorkflowReviewDecision({
    pending: reviewPending, decision: 'approve', actorOpenId: 'wrong', approverOpenId: 'approver',
    messageId: 'message', pendingKey: 'key',
  }).status, 'forbidden');
  assert.equal(applyWorkflowReviewDecision({
    pending: reviewPending, decision: 'approve', actorOpenId: 'approver', approverOpenId: 'approver',
    messageId: 'old-message', pendingKey: 'key',
  }).status, 'stale');
  assert.equal(applyWorkflowReviewDecision({
    pending: { ...reviewPending, reviewExpiresAt: new Date(Date.now() - 1).toISOString() },
    decision: 'approve', actorOpenId: 'approver', approverOpenId: 'approver',
    messageId: 'message', pendingKey: 'key',
  }).status, 'expired');
  assert.equal(applyWorkflowReviewDecision({
    pending: { ...reviewPending, reviewState: 'approved' }, decision: 'approve',
    actorOpenId: 'approver', approverOpenId: 'approver', messageId: 'message', pendingKey: 'key',
  }).status, 'duplicate');
  assert.equal(applyWorkflowReviewDecision({
    pending: reviewPending, decision: 'revise', actorOpenId: 'approver', approverOpenId: 'approver',
    messageId: 'message', pendingKey: 'key',
  }).status, 'prompt');
  const revisionRequested = applyWorkflowReviewDecision({
    pending: reviewPending, decision: 'revision', actorOpenId: 'approver', approverOpenId: 'approver',
    messageId: 'message', pendingKey: 'key', reviewFeedback: '请补充回滚步骤',
  });
  assert.equal(revisionRequested.status, 'applied');
  assert.equal(revisionRequested.pending.reviewState, 'revision_requested');
  assert.equal(revisionRequested.pending.reviewFeedback, '请补充回滚步骤');
  const revisionWithoutFeedback = applyWorkflowReviewDecision({
    pending: reviewPending, decision: 'revision', actorOpenId: 'approver', approverOpenId: 'approver',
    messageId: 'message', pendingKey: 'key',
  });
  assert.equal(revisionWithoutFeedback.status, 'applied');
  assert.equal(revisionWithoutFeedback.pending.reviewState, 'awaiting_revision_feedback');
  assert.equal(revisionWithoutFeedback.pending.reviewFeedback, '');
  const feedbackApplied = applyWorkflowRevisionFeedback({
    pending: {
      ...revisionWithoutFeedback.pending,
      revisionFeedbackMessageId: 'feedback-message',
    },
    actorOpenId: 'approver',
    approverOpenId: 'approver',
    parentMessageId: 'feedback-message',
    feedback: '请修改第二个 Slice',
  });
  assert.equal(feedbackApplied.status, 'applied');
  assert.equal(feedbackApplied.pending.reviewState, 'revision_requested');
  assert.equal(feedbackApplied.pending.reviewFeedback, '请修改第二个 Slice');
  const cardFeedbackApplied = applyWorkflowRevisionFeedback({
    pending: revisionWithoutFeedback.pending,
    actorOpenId: 'approver',
    approverOpenId: 'approver',
    pendingKey: 'key',
    feedback: '请从卡片补充 S03',
  });
  assert.equal(cardFeedbackApplied.status, 'applied');
  assert.equal(cardFeedbackApplied.pending.reviewFeedback, '请从卡片补充 S03');
  assert.equal(applyWorkflowRevisionFeedback({
    pending: revisionWithoutFeedback.pending,
    actorOpenId: 'approver',
    approverOpenId: 'approver',
    pendingKey: 'stale-key',
    feedback: '不应生效',
  }).status, 'ignored');
  assert.equal(applyWorkflowRevisionFeedback({
    pending: revisionWithoutFeedback.pending,
    actorOpenId: 'someone-else',
    approverOpenId: 'approver',
    parentMessageId: 'feedback-message',
    feedback: '不应生效',
  }).status, 'ignored');
  await writeFile(messagesFile, JSON.stringify({ data: { has_more: false, messages: [
    { sender: { id: 'approver' }, msg_type: 'text', content: 'approve', parent_id: 'review-1' },
    { sender: { id: 'coding-app' }, msg_type: 'text', content: '✅ 已为全部 4 个 agent 重置 session' },
  ] } }));
  const approved = await run(revisedReviewCursor);
  assert.match(approved.summary, /result=session_started/);
  assert.equal(importedDocuments.length, 2, 'pending retry must reuse the revised document');

  await writeFile(path.join(root, 'docs/branch/main/004_PLAN_20260725_approval.md'), `---
doc_type: PLAN
doc_status: draft
next_action: await_plan_approval
plan_kind: phase
roadmap: 000_ROADMAP_20260725_test.md
parent_plan: null
parent_slice: null
return_to: null
---
S01
`);
  git('add', '.');
  git('commit', '-qm', 'draft plan approval');
  const approvalDocument = await run(approved.cursor);
  assert.match(
    approvalDocument.summary,
    /action=await_plan_approval gate=plan_review document_ready=true card_sent=true/,
  );
  await writeFile(messagesFile, JSON.stringify({ data: { has_more: false, messages: [
    { sender: { id: 'approver' }, msg_type: 'text', content: 'approve', parent_id: 'review-1' },
  ] } }));
  const approvalApproved = await run(approvalDocument.cursor);
  assert.match(approvalApproved.summary, /action=await_plan_approval result=approved/);

  await writeFile(path.join(root, 'docs/branch/main/005_PLAN_20260725_import_failure.md'), `---
doc_type: PLAN
doc_status: draft
next_action: await_plan_approval
plan_kind: phase
roadmap: 000_ROADMAP_20260725_test.md
parent_plan: null
parent_slice: null
return_to: null
---
S01
`);
  git('add', '.');
  git('commit', '-qm', 'plan import failure');
  const callsBeforeImportFailure = apiCalls.length;
  await assert.rejects(workflowWatcherHandler({
    project,
    job,
    mode: 'active',
    cursor: approvalApproved.cursor,
    signal: new AbortController().signal,
  }, undefined, async () => {
    throw new Error('fake import failed');
  }), /fake import failed/);
  assert.equal(apiCalls.length, callsBeforeImportFailure, 'failed import must not send a review card');
  const defaultImport = await workflowWatcherHandler({
    project,
    job,
    mode: 'active',
    cursor: approvalApproved.cursor,
    signal: new AbortController().signal,
  });
  assert.match(defaultImport.summary, /gate=plan_review document_ready=true/);
  assert.match(await readFile(callsFile, 'utf8'), /docs \+create --as bot/);

  job.config.active_side_effects_enabled = false;
  await assert.rejects(run(terminal.cursor), /active side effects require explicit config gate/);
  console.log('workflow watcher active/idempotency checks passed');
}

void main();
