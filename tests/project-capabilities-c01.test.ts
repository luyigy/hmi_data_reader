import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { prisma } from '../src/lib/prisma';
import { withProjectCapabilities } from '../src/lib/project-capabilities/runtime';
import { projectCapabilityPolicy } from '../src/lib/project-capabilities/policy';
import { projectCapabilityContext } from '../src/lib/project-capabilities/context';
import { deliverTaskImage } from '../src/lib/project-capabilities/image-delivery';
import { readAuthorizedImage } from '../src/lib/project-capabilities/image-file';
import { safeFeishuCard, replyImagePaths } from '../src/lib/feishu-card-markdown';
import { sendFeishuInteractiveMessage } from '../src/lib/feishu-api';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';

const execute = promisify(execFile);
async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const scratch = await mkdtemp(path.join(tmpdir(), 'project-capabilities-'));
  const repository = path.join(scratch, 'repository'), shared = path.join(scratch, 'images');
  await mkdir(repository); await mkdir(shared);
  execFileSync('git', ['init', '-q', repository]);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5AAAAABJRU5ErkJggg==', 'base64');
  await writeFile(path.join(shared, 'source.png'), image);
  const outside = path.join(scratch, 'unapproved-file'); await writeFile(outside, 'not approved for task');
  await symlink(outside, path.join(shared, 'outside-link'));
  const originalEnv = { app: process.env.FEISHU_APP_ID, secret: process.env.FEISHU_APP_SECRET }, originalFetch = global.fetch;
  process.env.FEISHU_APP_ID = 'cli_test'; process.env.FEISHU_APP_SECRET = 'host-only-test-secret';
  const user = await prisma.user.create({ data: { username: 'capability-test-' + Date.now(), passwordHash: 'not-a-real-password' } });
  const peer = await prisma.user.create({ data: { username: 'peer-' + Date.now(), passwordHash: 'test' } });
  const parent = await prisma.task.create({ data: { name: 'Capability route', ownerUserId: user.id } });
  const child = await prisma.task.create({ data: { name: 'Find and show image', workingDirectory: repository } });
  const graph = await prisma.taskGraphRun.create({ data: { parentTaskId: parent.id, version: 1, requestKey: 'cap-' + Date.now(), snapshotHash: 'fixture', snapshot: {},
    nodes: { create: { key: 'C01', dependsOn: [], acceptance: 'agent', executions: { create: { key: 'reader', repository, gitRef: 'HEAD', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', childTaskId: child.id, worktreePath: repository, claimToken: 'claim' } } } } } });
  const run = await prisma.taskRun.create({ data: { taskId: child.id, status: 'running' } });
  const policyFile = path.join(scratch, 'project-capabilities.json');
  const policy = { version: 1, projects: [{ repository, appId: 'cli_test', principals: ['platform:' + user.id, 'platform:' + peer.id], readOnlyRoots: [shared], sources: [
    { key: 'approved', baseToken: 'baseTest', tableId: 'tblTest', searchField: 'Brand', imageFields: ['Photos'] },
    { key: 'other', baseToken: 'baseOther', tableId: 'tblOther', searchField: 'Brand', imageFields: ['Photos'] },
  ] }] };
  await writeFile(policyFile, JSON.stringify(policy));
  const registered = await projectCapabilityPolicy(repository, policyFile); assert(registered);
  await prisma.taskGraphRun.update({ where: { id: graph.id }, data: { snapshot: { nodes: [{ key: 'C01', executions: [{ key: 'reader', repository, capabilities: { policyHash: registered.hash, sources: ['approved'], readOnlyRoots: [shared] } }] }] } } });
  let downloads = 0, sends = 0, uploads = 0, lastCard = '', mismatch = false;
  const fields = { Brand: 'approved brand', Photos: [{ file_token: 'tokenImage', type: 'image/png', name: 'photo.png', size: image.length }] };
  global.fetch = async (input, init) => {
    const url = String(input);
    const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/auth/v3/')) return json({ code: 0, tenant_access_token: 'host-only-token', expire: 7200 });
    if (url.includes('/records/search')) return json({ code: 0, data: { items: [{ record_id: 'recTest', fields }], has_more: false } });
    if (url.endsWith('/records/recTest')) return json({ code: 0, data: { record: { record_id: 'recTest', fields } } });
    if (url.includes('/medias/tokenImage/download')) { downloads++; return new Response(new Uint8Array(image)); }
    if (url.endsWith('/images')) { uploads++; return json({ code: 0, data: { image_key: 'img_test' } }); }
    if (url.includes('/om_root/reply')) { sends++; return json({ code: 0, data: { message_id: 'om_sent' } }); }
    if (url.endsWith('/messages/om_sent')) return json({ code: 0, data: { items: [{ message_id: 'om_sent', chat_id: mismatch ? 'other' : 'oc_test', thread_id: 'omt_test', msg_type: 'image', body: { content: JSON.stringify({ image_key: 'img_test' }) } }] } });
    if (url.includes('/im/v1/messages')) { lastCard = String(init?.body); return json({ code: 0, data: { message_id: 'om_card' } }); }
    throw new Error('Unexpected host request: ' + url);
  };
  try {
    assert.equal(await projectCapabilityContext({ taskId: parent.id, workspace: repository, policyFile }), null, 'Ordinary tasks cannot inherit owner-only capability grants');
    let firstPath = '', closedSocket = '';
    const client = path.resolve('scripts/project-capability-client.cjs');
    const launch = async (access: Parameters<Parameters<typeof withProjectCapabilities>[1]>[0], argv: string[]) => {
      const env = { NODE_ENV: 'test' as const, PATH: process.env.PATH, HOME: '/tmp', AP_TASK_SANDBOX: '1', AP_SANDBOX_MODEL_ACCESS: '0', ...access.env };
      const wrapped = wrapWithBubblewrap({ command: process.execPath, commandArgs: [client, ...argv], workspaceRoot: repository, cwd: repository,
        env, sandboxMode: 'read-only', networkAccess: 'restricted', readOnlyPaths: access.readOnlyPaths });
      try {
        const result = await execute(wrapped.command, wrapped.args, { env, timeout: 40_000 });
        assert.doesNotMatch(result.stdout, /host-only/);
        return JSON.parse(result.stdout);
      } catch (error) {
        if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' && error.stdout.trim().startsWith('{')) throw new Error(JSON.parse(error.stdout).error);
        throw error;
      }
    };
    for (let attempt = 0; attempt < 2; attempt++) await withProjectCapabilities({ taskId: child.id, taskRunId: run.id, workspace: repository, policyFile, root: path.join(scratch, 'materials') }, async access => {
      closedSocket = access.env.AP_PROJECT_CAPABILITY_SOCKET;
      assert(access.readOnlyPaths.includes(shared));
      const probeEnv = { NODE_ENV: 'test' as const, PATH: process.env.PATH, HOME: '/tmp', AP_TASK_SANDBOX: '1', AP_SANDBOX_MODEL_ACCESS: '0', ...access.env };
      const probe = wrapWithBubblewrap({ command: process.execPath, commandArgs: ['-e', `const fs=require('fs');fs.readFileSync(${JSON.stringify(path.join(shared, 'source.png'))});if(fs.existsSync(${JSON.stringify(path.join(shared, 'outside-link'))}))throw Error('symlink widened grant');`], cwd: repository, workspaceRoot: repository,
        env: probeEnv, sandboxMode: 'read-only', networkAccess: 'restricted', readOnlyPaths: access.readOnlyPaths });
      await execute(probe.command, probe.args, { env: probeEnv });

      const sources = await launch(access, ['sources']); assert.equal(sources.sources[0].key, 'approved');
      await assert.rejects(launch(access, ['query', 'other', 'brand']));
      await assert.rejects(launch(access, ['image', 'approved', 'recUnknown', 'Photos', '0']));
      const found = await launch(access, ['query', 'approved', 'brand']); assert.equal(found.records[0].id, 'recTest');
      const result = await launch(access, ['image', 'approved', 'recTest', 'Photos', '0']);
      firstPath = result.path; assert.deepEqual(await readFile(result.path), image);
      if (attempt === 0) {
        fields.Photos[0].file_token = 'changedToken';
        await assert.rejects(launch(access, ['image', 'approved', 'recTest', 'Photos', '0']), /版本已改变/);
        fields.Photos[0].file_token = 'tokenImage';
        const node = await prisma.taskGraphNode.findFirstOrThrow({ where: { runId: graph.id } });
        const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } });
        const input = await prisma.taskGraphEvent.create({ data: { runId: graph.id, nodeId: node.id, kind: 'conversation_input', idempotencyKey: 'peer-input', payload: { actorId: peer.id, actorOrigin: 'platform' } } });
        await prisma.taskGraphEvent.create({ data: { runId: graph.id, nodeId: node.id, kind: 'conversation_steering_started', idempotencyKey: 'peer-steering', payload: { inputId: input.id, taskRunId: run.id, executionId: job.id } } });
        const continued = await launch(access, ['image', 'approved', 'recTest', 'Photos', '0']);
        assert.equal(continued.path, firstPath, 'Authorized steering preserves publication identity');
      }
      assert.match(await readFile(result.receipt, 'utf8'), /unverified_business_input/);
      if (attempt === 1) {
        await writeFile(policyFile, JSON.stringify({ ...policy, projects: [] }));
        await assert.rejects(launch(access, ['image', 'approved', 'recTest', 'Photos', '0']), /授权|访问/);
        await writeFile(policyFile, JSON.stringify(policy));
      }
    });
    assert.equal(downloads, 1, 'Cached bytes reused after current authorization and attachment membership checks');
    await assert.rejects(readFile(closedSocket), /ENOENT/);
    const context = await projectCapabilityContext({ taskId: child.id, workspace: repository, taskRunId: run.id, policyFile }); assert(context);
    const target = { appId: 'cli_test', chatId: 'oc_test', rootMessageId: 'om_root', threadId: 'omt_test' };
    await deliverTaskImage({ taskId: child.id, taskRunId: run.id, path: firstPath, roots: [path.dirname(firstPath)], target });
    await deliverTaskImage({ taskId: child.id, taskRunId: run.id, path: firstPath, roots: [path.dirname(firstPath)], target });
    assert.equal(sends, 1); assert.equal(uploads, 1);
    mismatch = true;
    await assert.rejects(deliverTaskImage({ taskId: child.id, taskRunId: 'another-turn', path: firstPath, roots: [path.dirname(firstPath)], target }), /不匹配/);
    await assert.rejects(deliverTaskImage({ taskId: child.id, taskRunId: 'another-turn', path: firstPath, roots: [path.dirname(firstPath)], target }), /不确定/);
    const linked = path.join(shared, 'escape.png'); await symlink(firstPath, linked);
    await assert.rejects(readAuthorizedImage(linked, [shared]), /路径/);
    assert.deepEqual(replyImagePaths('`![example](/x.png)`\n```md\n![example](/y.png)\n```\n![photo](/actual.png)'), ['/actual.png']);
    const card = { elements: [{ tag: 'markdown', content: '示例 `![图片](/tmp/image.png)`，答复仍在。' }] };
    assert.doesNotMatch(JSON.stringify(safeFeishuCard(card)), /!\[/);
    await sendFeishuInteractiveMessage({ receiveId: 'oc_test', card }); assert.doesNotMatch(lastCard, /!\[/);
    const outsider = await prisma.user.create({ data: { username: 'outsider-' + Date.now(), passwordHash: 'test' } });
    await prisma.task.update({ where: { id: parent.id }, data: { ownerUserId: outsider.id } });
    await assert.rejects(projectCapabilityContext({ taskId: child.id, workspace: repository, taskRunId: run.id, policyFile }), /未获/);
    const events = await prisma.taskGraphEvent.findMany({ where: { runId: graph.id, kind: 'project_material_added' } });
    assert.equal(events.length, 3); assert.doesNotMatch(JSON.stringify(events), /host-only-token|host-only-test-secret/);
    console.log('C01: real Bubblewrap without network can query and read selected images; cache reuse rechecks authorization; bound-topic image sends dedupe and verify; examples retain text.');
  } finally {
    global.fetch = originalFetch;
    if (originalEnv.app === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = originalEnv.app;
    if (originalEnv.secret === undefined) delete process.env.FEISHU_APP_SECRET; else process.env.FEISHU_APP_SECRET = originalEnv.secret;
    await rm(scratch, { recursive: true, force: true }); await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
