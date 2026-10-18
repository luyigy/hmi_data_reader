import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { getHarnessAdapter } from '../src/lib/harness';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = mkdtempSync(path.join(tmpdir(), 'graph-notification-'));
  const repository = path.join(root, 'repo'); mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  writeFileSync(path.join(repository, 'baseline'), 'base'); git('add', '.'); git('commit', '-m', 'base');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime');
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  process.env.TASK_GRAPH_UPSTREAM_ROOT = path.join(root, 'upstream');
  const app = randomUUID(); process.env.FEISHU_APP_ID = app;
  const require = createRequire(__filename); const api = require('../src/lib/feishu-api'); const entry = require('../src/lib/feishu-task-entry-api');
  const sends = new Map<string, string>(); const attempts: string[] = []; let updateFailures = 1;
  api.getFeishuTenantAccessToken = async () => 'fixture';
  api.sendFeishuInteractiveMessage = async (args: { receiveId: string; uuid: string }) => {
    assert.equal(args.receiveId, 'repo-group', 'Detailed output must not fall back to approval DM');
    attempts.push(args.uuid);
    if (!sends.has(args.uuid)) { sends.set(args.uuid, `message-${sends.size}`); throw new Error('response lost after accepted send'); }
    return sends.get(args.uuid);
  };
  entry.getFeishuTaskThread = async () => 'repo-thread';
  entry.updateFeishuTaskEntryCard = async () => { if (updateFailures-- > 0) throw new Error('card update timeout'); };
  const parent = await prisma.task.create({ data: { name: 'notification fixture' } });
  const parentRoom = await prisma.liveRoom.create({ data: { title: 'approval', sourceTaskId: parent.id } });
  await prisma.feishuConversationBinding.create({ data: { scopeKey: app + '-dm', appId: app, chatId: 'approval-dm', chatType: 'p2p', liveRoomId: parentRoom.id } });
  const project = await prisma.liveRoom.create({ data: { title: 'repo', workingDirectory: repository } });
  await prisma.feishuConversationBinding.create({ data: { scopeKey: app + '-group', appId: app, chatId: 'repo-group', chatType: 'group', liveRoomId: project.id } });
  await prisma.feishuGroupTaskSettings.create({ data: { appId: app, chatId: 'repo-group', isolationEnabled: true } });
  let starts = 0;
  getHarnessAdapter('codex')!.execute = async ({ context }) => {
    starts++; writeFileSync(path.join(context.workingDirectory!, 'delivered'), 'done');
    return { success: true, executionTime: 1, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"done","evidence":["delivered"]}' };
  };
  // All outbound surfaces unrelated to the injected task-graph calls remain local fixtures.
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'fixture' } }));
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: app, definition: {
    specRef: 'fixture://notification', nodes: [{ key: 'N', goal: 'deliver', dependsOn: [], executionMode: 'lean',
      acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'),
        agentSelector: 'local:codex', instructions: 'fixture', launchConfig: { checks: [], participant: { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' } } }] }],
  } });
  try {
    for (let n = 0; n < 300; n++) {
      await runTaskGraphCycle();
      const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'N' } } });
      if (node.status === 'passed' || node.status === 'attention') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal);
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'N' } } })).status, 'passed', 'Notification timeout must not become a business dispatch failure');
    assert.equal(starts, 1);
    const { relayGraphNotifications } = await import('../src/lib/task-graph/notifications');
    const { relayTaskGraphRunReply } = await import('../src/lib/task-graph/run-reply-relay');
    for (let n = 0; n < 3; n++) {
      await prisma.taskGraphEvent.updateMany({ where: { runId: run.id, kind: 'notification_failed' }, data: { createdAt: new Date(0) } });
      await relayGraphNotifications();
    }
    const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id } } });
    const taskRun = await prisma.taskRun.findFirstOrThrow({ where: { taskId: job.childTaskId! } });
    const binding = await prisma.feishuConversationBinding.findFirstOrThrow({ where: { liveRoom: { sourceTaskId: job.childTaskId } } });
    assert.equal(binding.chatId, 'repo-group'); assert.equal(binding.threadId, 'repo-thread');
    assert.equal(await prisma.feishuTaskBindingRequest.count({ where: { sourceMessageId: `task-graph:${job.id}` } }), 1);
    await assert.rejects(relayTaskGraphRunReply(taskRun.id), /response lost/);
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: job.nodeId } })).status, 'passed');
    await relayTaskGraphRunReply(taskRun.id);
    const receipt = await prisma.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: taskRun.id } });
    updateFailures = 1;
    await assert.rejects(relayTaskGraphRunReply(taskRun.id, true), /card update timeout/);
    await relayTaskGraphRunReply(taskRun.id, true);
    assert.equal((await prisma.taskRunFeishuRelay.findUniqueOrThrow({ where: { taskRunId: taskRun.id } })).messageId, receipt.messageId);
    assert.equal(sends.size, 2, 'One logical topic and one detail card, despite lost responses');
    assert.equal(attempts.length, 4); assert.equal(starts, 1);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'dispatch_failed' } }), 0);
    console.log('Topic/card send and update timeouts do not stop business; durable replay reuses one repo topic and detail card without DM fallback');
  } finally {
    const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal);
    await prisma.$disconnect(); rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
