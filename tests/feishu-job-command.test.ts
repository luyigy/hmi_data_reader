import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFeishuCommand } from '../src/lib/feishu-command-parser';
import {
  explainWorkflowRun,
  formatManualRunResult,
  handleScheduledJobCommand,
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
assert.deepEqual(parseFeishuCommand(message('/ap job cursor workflow-watcher --latest')), {
  command: 'job',
  args: ['cursor', 'workflow-watcher'],
  options: { latest: 'true' },
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
  explainWorkflowRun('head=abc candidate=docs/004_PLAN.md gate=plan_review document_ready=true'),
  'PLAN 已就绪，等待下一次 watcher 发送审批卡片',
);
assert.equal(explainWorkflowRun('head=abc candidate=none'), '未发现新的可执行工作流文档');

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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

testCursor().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
