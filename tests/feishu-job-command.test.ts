import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFeishuCommand } from '../src/lib/feishu-command-parser';
import {
  buildWorkflowRetryPending,
  explainWorkflowRun,
  formatManualRunResult,
  formatWorkflowDiagnosis,
  formatWorkflowPending,
  handleScheduledJobCommand,
  inspectWorkflowCandidates,
  inspectWorkflowCursor,
} from '../src/lib/feishu-scheduled-jobs';

const message = (text: string) => ({
  chatId: 'chat',
  chatType: 'p2p',
  messageId: 'message',
  senderOpenId: 'user',
  messageType: 'text' as const,
  text,
  mentions: [],
  mentionNames: [],
});

assert.deepEqual(parseFeishuCommand(message('/ap jobs')), {
  command: 'jobs',
  args: [],
  options: {},
});
assert.deepEqual(parseFeishuCommand(message('/ap job disable workflow-watcher')), {
  command: 'job',
  args: ['disable', 'workflow-watcher'],
  options: {},
});
assert.deepEqual(parseFeishuCommand(message('/ap job stop workflow-watcher')), {
  command: 'job',
  args: ['stop', 'workflow-watcher'],
  options: {},
});
assert.deepEqual(parseFeishuCommand(message('/ap job retry workflow-watcher')), {
  command: 'job',
  args: ['retry', 'workflow-watcher'],
  options: {},
});
assert.deepEqual(parseFeishuCommand(message('/ap job diagnose workflow-watcher')), {
  command: 'job',
  args: ['diagnose', 'workflow-watcher'],
  options: {},
});
assert.deepEqual(parseFeishuCommand(message('/ap job cursor workflow-watcher --latest')), {
  command: 'job',
  args: ['cursor', 'workflow-watcher'],
  options: { latest: 'true' },
});
assert.deepEqual(parseFeishuCommand(message('/ap job cursor workflow-watcher --clear-pending')), {
  command: 'job',
  args: ['cursor', 'workflow-watcher'],
  options: { 'clear-pending': 'true' },
});
assert.deepEqual(parseFeishuCommand(message('/ap job schedule workflow-watcher --cron="*/5 * * * *"')), {
  command: 'job',
  args: ['schedule', 'workflow-watcher'],
  options: { cron: '*/5 * * * *' },
});
handleScheduledJobCommand({ command: 'jobs', args: [], options: {} }).then((response) => {
  assert.equal(response, '当前 job 命令需要来自 Feishu webhook 的会话上下文。');
});

assert.equal(formatManualRunResult('watcher', {
  status: 'succeeded',
  summary: 'head=abc candidate=none',
}), '✅ watcher 手动执行完成：head=abc candidate=none');
assert.equal(formatManualRunResult('watcher', {
  status: 'failed',
  error: 'invalid workflow document',
}), '❌ watcher 手动执行失败：invalid workflow document');
assert.equal(formatManualRunResult('watcher', {
  status: 'timed_out',
  error: 'job timed out after 1000ms',
}), '❌ watcher 手动执行超时：job timed out after 1000ms');
assert.equal(formatManualRunResult('watcher', {
  status: 'skipped',
  summary: 'job already running',
}), 'watcher 未执行（job already running）。');
assert.equal(
  explainWorkflowRun('head=abc candidate=docs/004_PLAN.md gate=plan_review document_ready=true card_sent=true'),
  'PLAN 审批卡已发送，等待审批',
);
assert.equal(explainWorkflowRun('head=abc candidate=none'), '未发现新的可执行工作流文档');
assert.deepEqual(formatWorkflowPending({ pending: {
  path: 'docs/009_PLAN.md',
  gate: 'plan_review',
  action: 'start_first_slice',
  reviewState: 'review',
  reviewExpiresAt: '2026-07-27T12:00:00.000Z',
  reviewMessageId: 'message-9',
} }), [
  'pending: docs/009_PLAN.md',
  'pending gate: plan_review',
  'pending action: start_first_slice',
  'review state: review',
  'review expires: 2026-07-27T12:00:00.000Z',
  'review message: message-9',
]);
assert.deepEqual(formatWorkflowPending({ commit: 'abc' }), ['pending: none']);
assert.deepEqual(buildWorkflowRetryPending({
  key: 'plan',
  reviewState: 'revision',
  reviewFeedback: '',
  revisionDispatched: true,
  revisionFeedbackMessageId: 'old-message',
  revisionDispatchKey: 'old-key',
}, 'request-1'), {
  key: 'plan',
  reviewState: 'awaiting_revision_feedback',
  reviewFeedback: '',
  revisionDispatched: false,
});
assert.deepEqual(buildWorkflowRetryPending({
  key: 'plan',
  reviewState: 'awaiting_revision_feedback',
  reviewFeedback: '',
  revisionFeedbackMessageId: 'legacy-text-message',
}, 'request-feedback'), {
  key: 'plan',
  reviewState: 'awaiting_revision_feedback',
  reviewFeedback: '',
  revisionDispatched: false,
});
assert.deepEqual(buildWorkflowRetryPending({
  key: 'plan',
  reviewState: 'revision',
  reviewFeedback: '请补充风险',
  revisionDispatched: true,
}, 'request-2'), {
  key: 'plan',
  reviewState: 'revision',
  reviewFeedback: '请补充风险',
  revisionDispatched: false,
  revisionDispatchKey: 'plan:retry:request-2',
});

async function testCursor() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'job-cursor-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]).toString().trim();
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(path.join(root, 'file'), 'one');
    git('add', 'file');
    git('commit', '-qm', 'one');
    const current = git('rev-parse', 'HEAD');
    writeFileSync(path.join(root, 'file'), 'two');
    git('commit', '-qam', 'two');
    const status = await inspectWorkflowCursor(root, 'HEAD', { commit: current });
    assert.equal(status.current, current);
    assert.equal(status.behind, 1);
    assert.equal(status.rewritten, false);
    assert.match(formatWorkflowDiagnosis({
      projectName: 'Test',
      jobId: 'workflow-watcher',
      enabled: true,
      running: false,
      mode: 'active',
      schedule: '* * * * *',
      cursor: status,
      pending: { pending: { path: 'docs/001_PLAN.md' } },
      candidates: ['docs/001_PLAN.md'],
      lastError: 'old error',
      recentFailure: { status: 'failed', error: 'new error' },
    }), /diagnosis \(read-only\)[\s\S]*cursor is ancestor of head: true[\s\S]*workflow candidates: docs\/001_PLAN\.md[\s\S]*不会写数据库/);

    mkdirSync(path.join(root, 'docs/workflow'), { recursive: true });
    writeFileSync(
      path.join(root, 'docs/workflow/workflow-contract.yaml'),
      readFileSync(path.join(process.cwd(), 'docs/workflow/workflow-contract.yaml')),
    );
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs/001_PLAN_20260728_test.md'), '---\ndoc_type: PLAN\n---\n');
    git('add', '.');
    git('commit', '-qm', 'workflow candidate');
    const head = git('rev-parse', 'HEAD');
    assert.deepEqual(await inspectWorkflowCandidates(root, head, { commit: current, eventKey: 'seen' }, {
      contract_path: 'docs/workflow/workflow-contract.yaml',
      branch_space: '.',
      initial_cursor_commit: current,
    }), ['docs/001_PLAN_20260728_test.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

testCursor().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
