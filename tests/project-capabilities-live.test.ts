/** Explicit opt-in: real Feishu traffic, scratch database only. Never dispatches business nodes. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { prisma } from '../src/lib/prisma';
import { getFeishuTenantAccessToken } from '../src/lib/feishu-api';
import { withProjectCapabilities } from '../src/lib/project-capabilities/runtime';
import { projectCapabilityPolicy, object } from '../src/lib/project-capabilities/policy';
import { deliverTaskImage } from '../src/lib/project-capabilities/image-delivery';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';

async function main() {
  const configPath = process.env.AP_CAPABILITY_LIVE_CONFIG;
  if (!configPath) { console.log('Live capabilities skipped; no explicit live config.'); return; }
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const config = object(JSON.parse(await fs.readFile(configPath, 'utf8'))), target = object(config.target);
  for (const field of ['appId', 'chatId', 'threadId', 'rootMessageId']) assert.equal(typeof target[field], 'string');
  assert.equal(target.appId, process.env.FEISHU_APP_ID);
  assert.equal(typeof config.query, 'string');
  const output = path.resolve(String(config.output));
  await fs.mkdir(output, { recursive: true });
  const intent = path.join(output, 'send-intent.json');
  await fs.writeFile(intent, JSON.stringify({ target, startedAt: new Date().toISOString(), warning: 'A second run requires prior message reconciliation.' }), { flag: 'wx' });
  const token = await getFeishuTenantAccessToken();
  const root = object(await (await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${target.rootMessageId}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) })).json());
  assert.equal(root.code, 0);
  const messages = object(root.data).items; assert(Array.isArray(messages));
  const message = messages.map(object).find(row => row.message_id === target.rootMessageId); assert(message);
  assert.equal(message.chat_id, target.chatId); assert.equal(message.thread_id, target.threadId);
  await fs.writeFile(path.join(output, 'target.json'), JSON.stringify({ messageId: message.message_id, chatId: message.chat_id, threadId: message.thread_id }));
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'capability-live-'));
  try {
    const repository = path.join(scratch, 'repo'); await fs.mkdir(repository); execFileSync('git', ['init', '-q', repository]);
    const user = await prisma.user.create({ data: { username: 'capability-live-' + Date.now(), passwordHash: 'fixture-only' } });
    const parent = await prisma.task.create({ data: { name: 'C01 isolated live probe', ownerUserId: user.id } });
    const child = await prisma.task.create({ data: { name: 'C01 find/view/reply probe', workingDirectory: repository } });
    const policyFile = path.join(scratch, 'policy.json');
    await fs.writeFile(policyFile, JSON.stringify({ version: 1, projects: [{ repository, appId: target.appId, principals: ['platform:' + user.id], readOnlyRoots: [], sources: [config.source] }] }));
    const policy = await projectCapabilityPolicy(repository, policyFile); assert(policy);
    await prisma.taskGraphRun.create({ data: { parentTaskId: parent.id, version: 1, requestKey: 'live-' + Date.now(), snapshotHash: 'isolated-probe',
      snapshot: { nodes: [{ key: 'C01', executions: [{ key: 'probe', repository, capabilities: { policyHash: policy.hash, sources: policy.sources.map(source => source.key), readOnlyRoots: [] } }] }] },
      nodes: { create: { key: 'C01', dependsOn: [], acceptance: 'agent', executions: { create: { key: 'probe', repository, gitRef: 'HEAD', baseCommit: 'a'.repeat(40), agentSelector: 'local:codex', childTaskId: child.id, worktreePath: repository, claimToken: 'isolated-live-claim' } } } } } });
    const run = await prisma.taskRun.create({ data: { taskId: child.id, status: 'running' } });
    await withProjectCapabilities({ taskId: child.id, taskRunId: run.id, workspace: repository, policyFile, root: path.join(output, 'materials') }, async access => {
      const client = path.resolve('scripts/project-capability-client.cjs');
      const invoke = async (argv: string[]) => {
        const env = { NODE_ENV: 'test' as const, PATH: process.env.PATH, HOME: '/tmp', AP_TASK_SANDBOX: '1', AP_SANDBOX_MODEL_ACCESS: '0', ...access.env };
        const wrapped = wrapWithBubblewrap({ command: process.execPath, commandArgs: [client, ...argv], workspaceRoot: repository, cwd: repository, env,
          sandboxMode: 'read-only', networkAccess: 'restricted', readOnlyPaths: access.readOnlyPaths });
        return object(JSON.parse((await promisify(execFile)(wrapped.command, wrapped.args, { env, timeout: 60000 })).stdout));
      };
      const found = await invoke(['query', policy.sources[0].key, String(config.query)]);
      const records = found.records; assert(Array.isArray(records));
      const selected = records.map(object).find(record => Array.isArray(record.images) && record.images.length); assert(selected);
      assert(Array.isArray(selected.images)); const image = object(selected.images[0]);
      const result = await invoke(['image', policy.sources[0].key, String(selected.id), String(image.field), String(image.index)]);
      assert.equal(typeof result.path, 'string');
      const actual = await fs.readFile(String(result.path)); assert(actual.length > 0);
      const verifiedTarget = { appId: String(target.appId), chatId: String(target.chatId), threadId: String(target.threadId), rootMessageId: String(target.rootMessageId) };
      const messageId = await deliverTaskImage({ taskId: child.id, taskRunId: run.id, path: String(result.path), roots: [path.dirname(String(result.path))], target: verifiedTarget });
      await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify({ messageId, target: verifiedTarget, recordId: selected.id, field: image.field, ...result, bytes: actual.length, businessAcceptance: false }, null, 2));
      console.log(JSON.stringify({ messageId, recordId: selected.id, bytes: actual.length, output, businessAcceptance: false }));
    });
  } finally { await fs.rm(scratch, { recursive: true, force: true }); await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
