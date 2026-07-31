import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFeishuCommand } from '../src/lib/feishu-command-parser';
import {
  buildWorkflowDashboardCard,
  buildWorkflowResendPending,
  buildWorkflowRetryPending,
  explainWorkflowRun,
  formatManualRunResult,
  formatWorkflowDiagnosis,
  formatWorkflowPending,
  handleScheduledJobCommand,
  inspectWorkflowCandidates,
  inspectWorkflowCursor,
} from '../src/lib/feishu-scheduled-jobs';
import {
  buildWorkflowCompletionReceipt,
  extractWorkflowValidationSummary,
  formatWorkflowStatus,
  type WorkflowStatus,
} from '../src/lib/scheduled-jobs/workflow-status';

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
assert.deepEqual(parseFeishuCommand(message('/ap dashboard')), {
  command: 'job',
  args: ['dashboard', 'workflow-watcher'],
  options: {},
});
assert.deepEqual(parseFeishuCommand(message('/ap dashboard custom-watcher')), {
  command: 'job',
  args: ['dashboard', 'custom-watcher'],
  options: {},
});
assert.deepEqual(parseFeishuCommand(message('/ap workflow policy set --preset=workspace')), {
  command: 'workflow',
  args: ['policy', 'set'],
  options: { preset: 'workspace' },
});
assert.deepEqual(parseFeishuCommand(message('/ap workflow status')), {
  command: 'workflow',
  args: ['status'],
  options: {},
});
assert.deepEqual(parseFeishuCommand(message('/ap workflow autonomy set manual --head=abcdef')), {
  command: 'workflow',
  args: ['autonomy', 'set', 'manual'],
  options: { head: 'abcdef' },
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
assert.deepEqual(parseFeishuCommand(message('/ap job resend workflow-watcher')), {
  command: 'job',
  args: ['resend', 'workflow-watcher'],
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
  '待处理文档：docs/009_PLAN.md',
  '等待节点：plan_review',
  '待执行动作：start_first_slice',
  '评审状态：review',
  '评审截止：2026-07-27T12:00:00.000Z',
  '评审消息：message-9',
]);
assert.deepEqual(formatWorkflowPending({ commit: 'abc' }), ['待处理文档：无']);
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
assert.deepEqual(buildWorkflowResendPending({
  key: 'plan',
  reviewState: 'review',
  reviewExpiresAt: 'future',
}), {
  key: 'plan',
  reviewState: 'review',
  reviewExpiresAt: '1970-01-01T00:00:00.000Z',
});
assert.equal(buildWorkflowResendPending({ key: 'plan', reviewState: 'revision' }), null);
assert.deepEqual(formatWorkflowPending({ pending: {
  path: 'docs/009_PLAN.md',
  gate: 'plan_review',
  action: 'start_first_slice',
  reviewState: 'revision',
  revisionDispatched: true,
  reviewExpiresAt: 'stale',
  reviewMessageId: 'stale',
} }), [
  '待处理文档：docs/009_PLAN.md',
  '等待节点：plan_review',
  '待执行动作：start_first_slice',
  '评审状态：revision',
  '修改任务已投递：是',
]);
const workflowStatus: WorkflowStatus = {
  projectId: 'project',
  projectName: 'HMI Reader',
  repository: '/repo',
  ref: 'refs/heads/main',
  head: 'abcdef1234',
  jobId: 'workflow-watcher',
  enabled: true,
  running: false,
  mode: 'active',
  autonomy: 'semi_auto',
  autonomySource: 'config',
  schedule: '* * * * *',
  stage: '等待修改提交',
  documentPath: 'docs/007_PLAN.md',
  plan: 'docs/007_PLAN.md',
  slice: 'S02',
  action: 'start_first_slice',
  approval: 'revision',
  session: 'session-1 · waiting_user · needs_review · run -',
  validator: 'valid：最近一轮 watcher 已成功完成',
  lastFinishedAt: '2026-07-30T00:00:00.000Z',
  lastSuccessAt: '2026-07-30T00:00:00.000Z',
  lastError: '-',
  retry: 'approval_revision',
  nextStep: '完成并提交 docs/007_PLAN.md 的修订',
  lastRun: {
    status: 'succeeded',
    summary: 'gate=plan_revision',
    startedAt: '2026-07-30T00:00:00.000Z',
  },
};
const dashboardCard = buildWorkflowDashboardCard({
  status: workflowStatus,
  cursor: { current: '1234567890', latest: 'abcdef1234', rewritten: false, behind: 1 },
  pending: {
    path: 'docs/007_PLAN.md',
    action: 'start_first_slice',
    gate: 'plan_review',
    reviewState: 'revision',
    revisionDispatched: true,
    reviewExpiresAt: 'stale-expiry',
  },
});
assert.match(JSON.stringify(dashboardCard), /修改任务已投递，等待 PLAN 提交/);
assert.match(JSON.stringify(dashboardCard), /恢复修改任务/);
assert.doesNotMatch(JSON.stringify(dashboardCard), /stale-expiry/);
assert.match(JSON.stringify(dashboardCard), /唯一下一步/);
assert.match(JSON.stringify(dashboardCard), /autonomy_manual/);
assert.match(JSON.stringify(dashboardCard), /abcdef1234/);
assert.match(formatWorkflowStatus(workflowStatus), /项目 \/ ref \/ HEAD：project/);
assert.match(formatWorkflowStatus(workflowStatus), /自治模式：semi_auto（config）/);
assert.match(formatWorkflowStatus(workflowStatus), /唯一下一步：完成并提交/);
assert.equal(
  extractWorkflowValidationSummary('# H\n\n## 验证结果\n\n- `npm test`：通过。\n- `npx tsc`：通过。\n\n## 边界\n'),
  '`npm test`：通过。；`npx tsc`：通过。',
);
assert.match(buildWorkflowCompletionReceipt({
  commit: 'abc123',
  documentPath: 'docs/009_HANDOVER.md',
  action: 'await_acceptance',
  validation: 'npm test：通过',
}), /PLAN 已完成，等待人工验收[\s\S]*commit：abc123[\s\S]*实际验证：npm test：通过/);
assert.match(buildWorkflowCompletionReceipt({
  commit: 'def456',
  documentPath: 'docs/010_HANDOVER.md',
  action: 'next_slice',
  validation: 'npm test：通过',
  slice: 'S02',
}), /Slice S02 已完成[\s\S]*将按 next_slice 启动下一 Session/);

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
    }), /诊断（只读）[\s\S]*游标属于当前历史：是[\s\S]*候选工作流文档：docs\/001_PLAN\.md[\s\S]*不会写数据库/);

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
