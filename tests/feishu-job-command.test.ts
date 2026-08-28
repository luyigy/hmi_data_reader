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
import {
  buildWorkflowActivateCursor,
  formatWorkflowOverview,
  inspectWorkflowOverview,
} from '../src/lib/scheduled-jobs/workflow-inspection';
import { resolveWorkflowCursorRecovery } from '../src/lib/scheduled-jobs/workflow-dashboard-recovery';

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
assert.deepEqual(parseFeishuCommand(message('/ap workflow policy set --preset=workspace --extra-read=/a,/b --extra-write=/c')), {
  command: 'workflow',
  args: ['policy', 'set'],
  options: { preset: 'workspace', 'extra-read': '/a,/b', 'extra-write': '/c' },
});
assert.deepEqual(parseFeishuCommand(message('/ap workflow policy set --preset=workspace --extra-read=')), {
  command: 'workflow',
  args: ['policy', 'set'],
  options: { preset: 'workspace', 'extra-read': '' },
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
assert.deepEqual(parseFeishuCommand(message('/ap workflow validation set strict --head=abcdef')), {
  command: 'workflow',
  args: ['validation', 'set', 'strict'],
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
assert.deepEqual(parseFeishuCommand(message('/ap job activate workflow-watcher --plan=docs/010_PLAN.md --head=abcdef')), {
  command: 'job',
  args: ['activate', 'workflow-watcher'],
  options: { plan: 'docs/010_PLAN.md', head: 'abcdef' },
});
assert.deepEqual(buildWorkflowActivateCursor(
  { commit: 'abc', eventKey: 'seen' },
  'docs/010_PLAN.md',
), { commit: 'abc', eventKey: 'seen', selectedPlan: 'docs/010_PLAN.md' });
assert.equal(buildWorkflowActivateCursor(
  { commit: 'abc', pending: { path: 'docs/009_PLAN.md' } },
  'docs/010_PLAN.md',
), null);
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
assert.match(JSON.stringify(dashboardCard), /"tag":"collapsible_panel","expanded":false/);
assert.match(JSON.stringify(dashboardCard), /运行 \/ 模式 \/ 分支（semi_auto）[\s\S]*autonomy_manual[\s\S]*autonomy_auto/);
const activationStatus = {
    ...workflowStatus,
    stage: '空闲',
    overview: {
      inbox: [{
        path: 'docs/inbox/009_ISSUE.md',
        title: '待整理事项',
        status: 'draft',
        nextAction: 'none',
        source: 'docs/inbox/009_ISSUE.md',
      }],
      plans: [{
        path: 'docs/010_PLAN.md',
        number: 10,
        title: '可选计划',
        state: '等待启动（未进入 watcher 队列）',
        queuePosition: 1,
        slices: [],
      }],
      planDocuments: [{
        path: 'docs/010_PLAN.md',
        number: 10,
        title: '可选计划',
        state: '等待启动（未进入 watcher 队列）',
        slices: [],
      }, {
        path: 'docs/015_PLAN.md',
        number: 15,
        title: '已完成计划',
        state: '实施完成，等待人工验收',
        slices: [],
      }],
      handovers: [{
        path: 'docs/011_HANDOVER.md',
        number: 11,
        title: '交接文档',
        plan: 'docs/010_PLAN.md',
        slice: 'S01',
        planProgress: 'in_progress',
        nextAction: 'next_slice',
      }],
      others: [{
        path: 'docs/012_REPORT_20260801_summary.md',
        number: 12,
        type: 'REPORT',
        title: '总结报告',
      }],
      warnings: [],
      queue: [{
        path: 'docs/010_PLAN.md',
        number: 10,
        title: '可选计划',
        state: '等待启动（未进入 watcher 队列）',
        queuePosition: 1,
        slices: [],
      }],
    },
};
const activationCursor = { current: '1234567890', latest: 'abcdef1234', rewritten: false, behind: 1 };
const activationCard = buildWorkflowDashboardCard({
  status: activationStatus,
  cursor: activationCursor,
  pending: null,
});
assert.match(JSON.stringify(activationCard), /select_static/);
assert.match(JSON.stringify(activationCard), /docs\/010_PLAN\.md/);
assert.match(JSON.stringify(activationCard), /"action":"activate"/);
assert.match(JSON.stringify(activationCard), /"action_type":"form_submit"/);
assert.match(JSON.stringify(activationCard), /"name":"selectedDocument"/);
assert.match(JSON.stringify(activationCard), /选择要查看的文档/);
assert.match(JSON.stringify(activationCard), /查看所选文档/);
assert.equal(JSON.stringify(activationCard).match(/查看所选文档/g)?.length, 1);
assert.doesNotMatch(JSON.stringify(activationCard), /查看 (Inbox|PLAN|HANDOVER|其他)/);
assert.match(JSON.stringify(activationCard), /"action":"document"/);
assert.match(JSON.stringify(activationCard), /选择要校验的 PLAN 或 HANDOVER/);
assert.match(JSON.stringify(activationCard), /校验所选 PLAN \/ HANDOVER/);
assert.match(JSON.stringify(activationCard), /"action":"document_validate"/);
assert.match(JSON.stringify(activationCard), /✅ PLAN 人工完成 \/ 取消/);
assert.match(JSON.stringify(activationCard), /人工标记完成/);
assert.match(JSON.stringify(activationCard), /"action":"plan_complete"/);
assert.match(JSON.stringify(activationCard), /"selectedCompletionPlan":"docs\/010_PLAN\.md"/);
assert.match(JSON.stringify(activationCard), /取消实施/);
assert.match(JSON.stringify(activationCard), /"action":"plan_cancel"/);
const dashboardForms = activationCard.elements.filter(({ tag }) => tag === 'form') as Array<{
  elements: Array<{ tag: string; name?: string; action_type?: string }>;
}>;
assert(dashboardForms.length > 0);
assert(activationCard.elements.filter(({ tag }) => tag === 'collapsible_panel').every(({ elements }) => (
  !elements?.some(({ tag }: { tag: string }) => tag === 'form')
)));
assert(dashboardForms.every((form) => form.elements.filter((element) => (
  element.tag === 'button' && element.action_type === 'form_submit'
)).length === 1));
const dashboardFieldNames = dashboardForms.flatMap((form) => form.elements.flatMap(({ name }) => name ? [name] : []));
assert.equal(new Set(dashboardFieldNames).size, dashboardFieldNames.length);
assert.match(JSON.stringify(activationCard), /\[编号 009\] Inbox · 待整理事项/);
assert.match(JSON.stringify(activationCard), /\[编号 010\] PLAN · 可选计划/);
assert.match(JSON.stringify(activationCard), /\[编号 015\] PLAN · 已完成计划/);
assert.match(JSON.stringify(activationCard), /\[编号 011\] HANDOVER · 交接文档/);
assert.match(JSON.stringify(activationCard), /\[编号 012\] REPORT · 总结报告/);
const pendingPlanCard = buildWorkflowDashboardCard({
  status: activationStatus,
  cursor: activationCursor,
  pending: { path: 'docs/010_PLAN.md', gate: 'plan_review', reviewState: 'revision' },
});
assert.match(JSON.stringify(pendingPlanCard), /"action":"plan_cancel"/);
assert.match(JSON.stringify(pendingPlanCard), /"action":"plan_complete"/);
assert.match(JSON.stringify(dashboardCard), /validation_show/);
assert.match(JSON.stringify(dashboardCard), /validation_strict/);
assert.match(JSON.stringify(dashboardCard), /立即运行=马上扫描一次/);
assert.match(JSON.stringify(dashboardCard), /宽松：内容规范问题记为 warning/);
assert.match(JSON.stringify(dashboardCard), /"action":"branch_status"/);
assert.match(JSON.stringify(dashboardCard), /"action":"branch_apply"/);
assert.match(JSON.stringify(dashboardCard), /abcdef1234/);
const rewrittenCard = buildWorkflowDashboardCard({
  status: { ...workflowStatus, stage: '运行阻塞', validator: 'runtime_unavailable：configured Git ref was rewritten' },
  cursor: { current: '1234567890', latest: 'abcdef1234', rewritten: true, behind: undefined },
  pending: null,
});
assert.match(JSON.stringify(rewrittenCard), /共同祖先：重新扫描（推荐）/);
assert.match(JSON.stringify(rewrittenCard), /当前 HEAD abcdef12：跳过待处理提交/);
assert.match(JSON.stringify(rewrittenCard), /"action":"cursor_recover"/);
assert.match(JSON.stringify(rewrittenCard), /"name":"selectedCursorRecovery"/);
const idleCard = buildWorkflowDashboardCard({
  status: { ...workflowStatus, stage: '空闲', approval: 'none', overview: { inbox: [], plans: [], handovers: [], others: [], queue: [], warnings: [] } },
  cursor: { current: '1234567890', latest: 'abcdef1234', rewritten: false, behind: 1 },
  pending: null,
});
assert.match(JSON.stringify(idleCard), /✅ PLAN 人工完成 \/ 取消/);
assert.match(JSON.stringify(idleCard), /当前没有可人工完成或取消的未完成 PLAN/);
assert.match(JSON.stringify(idleCard), /立即检查新文档/);
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
}), /Slice S02 已完成[\s\S]*将按 next_slice 启动下一工作单元（Session 是否换代独立决定）/);

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

    const mainBranch = git('branch', '--show-current');
    git('checkout', '-qb', 'obsolete-cursor', current);
    writeFileSync(path.join(root, 'file'), 'obsolete');
    git('commit', '-qam', 'obsolete history');
    const obsolete = git('rev-parse', 'HEAD');
    git('checkout', '-q', mainBranch);
    const rescan = await resolveWorkflowCursorRecovery(root, 'HEAD', { commit: obsolete }, head, 'rescan');
    assert.equal(rescan.target, current);
    assert.equal(rescan.skipped, false);
    const skip = await resolveWorkflowCursorRecovery(root, 'HEAD', { commit: obsolete }, head, 'skip');
    assert.equal(skip.target, head);
    assert.equal(skip.skipped, true);
    await assert.rejects(resolveWorkflowCursorRecovery(root, 'HEAD', { commit: obsolete }, current, 'rescan'), /Dashboard 已过期/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testWorkflowOverview() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workflow-overview-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]).toString().trim();
    const write = (file: string, content: string) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), content);
    };
    const plan = (status: string, action: string, title: string) => `---\ndoc_type: PLAN\ndoc_status: ${status}\nnext_action: ${action}\nplan_kind: phase\n---\n\n# PLAN · ${title}\n\n### S01：第一步\n\n### S02：第二步\n`;
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    write('docs/workflow/workflow-contract.yaml', readFileSync(path.join(process.cwd(), 'docs/workflow/workflow-contract.yaml'), 'utf8'));
    git('add', '.');
    git('commit', '-qm', 'contract');
    const initial = git('rev-parse', 'HEAD');
    write('docs/010_PLAN_20260801_approval.md', plan('draft', 'await_plan_approval', '待审批'));
    write('docs/011_PLAN_20260801_duplicate.md', plan('ready', 'await_approval', '重复标题'));
    write('docs/012_PLAN_20260801_duplicate.md', plan('ready', 'start_first_slice', '重复标题'));
    write('docs/013_PLAN_20260801_blocked.md', plan('blocked', 'blocked', '阻塞计划'));
    write('docs/014_HANDOVER_20260801_progress.md', `---\ndoc_type: HANDOVER\ndoc_status: completed\nnext_action: next_slice\nplan: docs/011_PLAN_20260801_duplicate.md\nslice: S01\nplan_progress: in_progress\n---\n\n# HANDOVER · 第一阶段完成\n`);
    write('docs/015_PLAN_20260801_complete.md', plan('ready', 'start_first_slice', '完成计划'));
    write('docs/016_HANDOVER_20260801_complete.md', `---\ndoc_type: HANDOVER\ndoc_status: completed\nnext_action: await_acceptance\nplan: docs/015_PLAN_20260801_complete.md\nslice: S01\nplan_progress: complete\n---\n\n# HANDOVER\n`);
    write('docs/008_PLAN_20260722_legacy.md', '# Legacy PLAN without frontmatter\n');
    write('docs/009_HANDOVER_20260722_legacy.md', '# Legacy HANDOVER without frontmatter\n');
    write('docs/017_REPORT_20260801_summary.md', `---\ndoc_type: REPORT\ndoc_status: completed\nnext_action: none\n---\n\n# REPORT · 汇总报告\n`);
    write('docs/inbox/009_ISSUE_20260801_candidate.md', `---\ndoc_type: ISSUE\ndoc_status: draft\nnext_action: none\n---\n\n# ISSUE · Inbox candidate\n`);
    git('add', '.');
    git('commit', '-qm', 'plans');
    const head = git('rev-parse', 'HEAD');
    const overview = await inspectWorkflowOverview(root, head, { commit: head, eventKey: 'seen' }, {
      contract_path: 'docs/workflow/workflow-contract.yaml',
      branch_space: '.',
      initial_cursor_commit: initial,
    }, { ...workflowStatus, head, documentPath: '-', plan: '-', slice: '-', stage: '空闲' });
    assert.deepEqual(overview.plans.map(({ number, state }) => [number, state]), [
      [10, '等待激活'],
      [11, '等待激活'],
      [12, '重复计划（同 11）'],
      [13, '阻塞'],
    ]);
    assert.deepEqual(overview.planDocuments.map(({ number }) => number), [10, 11, 12, 13, 15]);
    assert.match(overview.warnings.join('\n'), /008_PLAN_20260722_legacy\.md: missing YAML front matter/);
    assert.match(overview.warnings.join('\n'), /009_HANDOVER_20260722_legacy\.md: missing YAML front matter/);
    assert.deepEqual(overview.queue.map(({ number, queuePosition }) => [number, queuePosition]), [[10, 1], [11, 2]]);
    assert.deepEqual(overview.inbox.map(({ title, source }) => [title, source]), [
      ['Inbox candidate', 'docs/inbox/009_ISSUE_20260801_candidate.md'],
    ]);
    assert.deepEqual(
      overview.handovers.map(({ number, slice, planProgress, nextAction }) => [number, slice, planProgress, nextAction]),
      [[14, 'S01', 'in_progress', 'next_slice']],
    );
    assert.deepEqual(overview.others.map(({ number, type, title }) => [number, type, title]), [
      [17, 'REPORT', '汇总报告'],
    ]);
    assert.deepEqual(overview.plans.find(({ number }) => number === 11)?.slices.map(({ id }) => id), ['S02']);
    assert.match(formatWorkflowOverview(overview), /队列分类：Inbox 1 · PLAN 4 · HANDOVER 1[\s\S]*未完成 PLAN 与 Slice：[\s\S]*S02[\s\S]*相关 HANDOVER：[\s\S]*next_slice[\s\S]*排队序列：[\s\S]*1\. 10[\s\S]*异常：/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

Promise.all([testCursor(), testWorkflowOverview()]).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
