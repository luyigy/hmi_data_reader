import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { graphTopicDestination } from '../src/lib/task-graph/repository-topic';
import { ensureGraphChildTopic } from '../src/lib/task-graph/feishu';
import { createTaskGraphRun } from '../src/lib/task-graph/store';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const uid = randomUUID(); const repository = `/fixture/repository-${uid}`;
  const app = `app-${uid}`; const previousApp = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = app;
  const require = createRequire(__filename); const api = require('../src/lib/feishu-api'); const entry = require('../src/lib/feishu-task-entry-api');
  const original = { send: api.sendFeishuInteractiveMessage, thread: entry.getFeishuTaskThread, update: entry.updateFeishuTaskEntryCard };
  const sent: string[] = [];
  api.sendFeishuInteractiveMessage = async (args: { receiveId: string }) => { sent.push(args.receiveId); return `root-${uid}`; };
  entry.getFeishuTaskThread = async () => `thread-${uid}`; entry.updateFeishuTaskEntryCard = async () => {};
  try {
    const parent = await prisma.task.create({ data: { name: 'DM route' } });
    const parentRoom = await prisma.liveRoom.create({ data: { title: parent.name, sourceTaskId: parent.id } });
    await prisma.feishuConversationBinding.create({ data: { scopeKey: uid, liveRoomId: parentRoom.id, appId: app, chatId: 'approval-dm', chatType: 'p2p' } });
    const registered = await prisma.liveRoom.create({ data: { title: 'Reader project', workingDirectory: repository } });
    await prisma.feishuConversationBinding.create({ data: { scopeKey: uid + '-repo', liveRoomId: registered.id, appId: app, chatId: 'registered-repo-group', chatType: 'group' } });
    await prisma.feishuGroupTaskSettings.create({ data: { appId: app, chatId: 'registered-repo-group', isolationEnabled: true } });
    assert.deepEqual(await graphTopicDestination(parent.id, repository), { appId: app, chatId: 'registered-repo-group' });
    const duplicate = await prisma.liveRoom.create({ data: { title: 'Same project topic', workingDirectory: repository } });
    await prisma.feishuConversationBinding.create({ data: { scopeKey: uid + '-dup', liveRoomId: duplicate.id, appId: app, chatId: 'registered-repo-group', chatType: 'group', rootMessageId: 'older-root' } });
    assert.deepEqual(await graphTopicDestination(parent.id, repository), { appId: app, chatId: 'registered-repo-group' });
    assert.equal(await graphTopicDestination(parent.id, `${repository}/nested`), null, 'Directory prefix must not guess a group');
    const child = await prisma.task.create({ data: { name: 'R01 reader' } });
    const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: uid, definition: { specRef: 'test://topic', nodes: [{
      key: 'R01', goal: 'Read screen', dependsOn: [], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] }, executions: [{
        key: 'reader', repository, gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'fixture',
        launchConfig: { participant: { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' } },
      }],
    }] } });
    const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id } } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: child.id } });
    const args = { parentTaskId: parent.id, executionId: job.id, childTaskId: child.id, title: child.name, workingDirectory: '/fixture/isolated-worktree' };
    const binding = await ensureGraphChildTopic(args); assert.ok(binding); assert.equal(binding.chatId, 'registered-repo-group');
    await ensureGraphChildTopic(args); assert.equal(sent.length, 1, 'Repeated creation reuses the registered child topic');
    await prisma.taskGraphRun.update({ where: { id: run.id }, data: { status: 'completed' } });
    const ambiguous = await prisma.liveRoom.create({ data: { title: 'Ambiguous project', workingDirectory: repository } });
    await prisma.feishuConversationBinding.create({ data: { scopeKey: uid + '-ambiguous', liveRoomId: ambiguous.id, appId: app, chatId: 'other-group', chatType: 'group' } });
    await assert.rejects(() => graphTopicDestination(parent.id, repository), /多个飞书群/);
    await prisma.liveRoom.update({ where: { id: ambiguous.id }, data: { status: 'archived' } });
    assert.equal((await graphTopicDestination(parent.id, repository))?.chatId, 'registered-repo-group');
    console.log('DM approval creates an idempotent child topic in exact repository group; duplicate topics dedupe, ambiguous groups reject, archived rooms do not route');
  } finally {
    api.sendFeishuInteractiveMessage = original.send; entry.getFeishuTaskThread = original.thread; entry.updateFeishuTaskEntryCard = original.update;
    if (previousApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previousApp;
    await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
