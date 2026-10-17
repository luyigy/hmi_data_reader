import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { syncGraphConversationMaterials, graphMaterialPathsForTask } from '../src/lib/task-graph/conversation-materials';
import { prepareGraphConversationTask } from '../src/lib/task-graph/conversation-task';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'graph-materials-'));
  const originalRoot = process.env.TASK_GRAPH_MATERIAL_ROOT;
  process.env.TASK_GRAPH_MATERIAL_ROOT = path.join(root, 'inputs');
  const originalFetch = globalThis.fetch;
  const require = createRequire(__filename);
  const api = require('../src/lib/feishu-api');
  const original = { token: api.getFeishuTenantAccessToken, download: api.downloadFeishuMessageResource };
  api.getFeishuTenantAccessToken = async () => 'host-only-token';
  const image = path.join(root, 'incoming.png'); writeFileSync(image, 'distinct-real-photo-fixture');
  const calls: string[] = [];
  let foreign = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('container_id_type'), 'thread', 'A group list never expands topic photos');
    assert.ok(['omt_fixture', 'omt_parent'].includes(url.searchParams.get('container_id')!));
    const parentTopic = url.searchParams.get('container_id') === 'omt_parent';
    calls.push(String(input));
    return new Response(JSON.stringify({ code: 0, data: { has_more: false, items: [
      { message_id: parentTopic ? 'om_parent_photo' : 'om_photo', chat_id: foreign ? 'foreign' : 'oc_fixture', thread_id: parentTopic ? 'omt_parent' : 'omt_fixture', msg_type: 'image', create_time: '1792231800000', sender: { sender_type: 'user', id: 'user' }, body: { content: JSON.stringify({ image_key: 'img_fixture' }) } },
      { message_id: 'om_bot', chat_id: 'oc_fixture', thread_id: 'omt_fixture', msg_type: 'image', sender: { sender_type: 'app' }, body: { content: JSON.stringify({ image_key: 'img_bot' }) } },
    ] } }));
  };
  api.downloadFeishuMessageResource = async (args: { messageId: string }) => {
    assert.ok(['om_photo', 'om_parent_photo'].includes(args.messageId), 'Bot screenshots are not user materials');
    return { filePath: image, contentType: 'image/png', sizeBytes: 27 };
  };
  const parent = await prisma.task.create({ data: { name: 'materials-parent' } });
  const child = await prisma.task.create({ data: { name: 'materials-child' } });
  const room = await prisma.liveRoom.create({ data: { title: 'materials', sourceTaskId: child.id } });
  let parentRoomId: string | undefined;
  let runId: string | undefined;
  let discussionId: string | undefined;
  try {
    await prisma.feishuConversationBinding.create({ data: { appId: 'fixture', chatId: 'oc_fixture', chatType: 'group', threadId: 'omt_fixture', rootMessageId: 'om_root', scopeKey: root, liveRoomId: room.id } });
    const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: root, definition: { specRef: 'test://materials', nodes: [{ key: 'S05', goal: 'review distinct photo', dependsOn: [], acceptance: { mode: 'automatic', checks: ['photo'] }, executions: [{ key: 'mold', repository: root, gitRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', instructions: 'fixture' }] }] } });
    runId = run.id;
    const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId } } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: child.id } });
    const before = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    const source = await prisma.task.findUniqueOrThrow({ where: { id: child.id }, include: { currentTaskSession: true } });
    const discussion = await prepareGraphConversationTask(source);
    discussionId = discussion.id;
    assert.match(discussion.description || '', /om_photo/, 'The actual conversation launch prompt carries the retrieved photo');
    const summary = await syncGraphConversationMaterials(child.id);
    assert.match(summary, /om_photo/); assert.doesNotMatch(summary, /host-only-token|om_bot/);
    const paths = await graphMaterialPathsForTask(`task-graph-discussion-${job.id}`);
    assert.equal(paths.length, 1);
    assert.deepEqual(await graphMaterialPathsForTask(`task-graph-review-${job.nodeId}`), paths);
    assert.deepEqual(await graphMaterialPathsForTask('task-graph-discussion-unknown'), []);
    const manifest = JSON.parse(readFileSync(path.join(paths[0], 'index.json'), 'utf8'));
    assert.equal(manifest.items.length, 1);
    const photo = path.join(paths[0], manifest.items[0].file);
    assert.equal(readFileSync(photo, 'utf8'), 'distinct-real-photo-fixture');
    const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
    const secret = path.join(root, 'lark-config.json'); writeFileSync(secret, 'private');
    const wrapped = wrapWithBubblewrap({ command: process.execPath, commandArgs: ['-e', `const fs=require('fs'),assert=require('assert');assert.equal(fs.readFileSync(${JSON.stringify(photo)},'utf8'),'distinct-real-photo-fixture');assert.throws(()=>fs.writeFileSync(${JSON.stringify(photo)},'changed'));assert(!fs.existsSync(${JSON.stringify(secret)}));`], cwd: workspace, workspaceRoot: workspace, sandboxMode: 'read-only', env: process.env, readOnlyPaths: paths });
    execFileSync(wrapped.command, wrapped.args, { env: process.env, stdio: 'pipe' });
    await syncGraphConversationMaterials(child.id);
    assert.equal(JSON.parse(readFileSync(path.join(paths[0], 'index.json'), 'utf8')).items.length, 1);
    const parentRoom = await prisma.liveRoom.create({ data: { title: 'parent', sourceTaskId: parent.id } }); parentRoomId = parentRoom.id;
    await prisma.feishuConversationBinding.create({ data: { appId: 'fixture', chatId: 'oc_fixture', chatType: 'group', threadId: 'omt_parent', rootMessageId: 'om_parent_root', scopeKey: root + ':parent', liveRoomId: parentRoom.id } });
    assert.match(await syncGraphConversationMaterials(child.id), /om_parent_photo/);
    assert.equal(JSON.parse(readFileSync(path.join(paths[0], 'index.json'), 'utf8')).items.length, 2, 'Parent and child material are collected without reposting');
    foreign = true;
    assert.match(await syncGraphConversationMaterials(child.id), /归属/);
    assert.equal(existsSync(photo), true, 'Transient failures retain previously obtained material');
    assert.deepEqual(await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } }), before);
    assert.ok(calls.length >= 2);
    console.log('Topic history photos reach discussion and acceptance sandboxes readonly, without CLI credentials or execution changes');
  } finally {
    globalThis.fetch = originalFetch; api.getFeishuTenantAccessToken = original.token; api.downloadFeishuMessageResource = original.download;
    if (discussionId) await prisma.task.delete({ where: { id: discussionId } });
    if (runId) await prisma.taskGraphRun.delete({ where: { id: runId } });
    if (parentRoomId) await prisma.liveRoom.delete({ where: { id: parentRoomId } });
    await prisma.liveRoom.delete({ where: { id: room.id } });
    await prisma.task.deleteMany({ where: { id: { in: [parent.id, child.id] } } });
    if (originalRoot === undefined) delete process.env.TASK_GRAPH_MATERIAL_ROOT; else process.env.TASK_GRAPH_MATERIAL_ROOT = originalRoot;
    rmSync(root, { recursive: true, force: true }); await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
