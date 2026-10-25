import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

type Approval = {
  id: string; status: string; requesterOpenId: string; requesterChatId: string;
  cardMessageId: string | null; expiresAt: Date | null;
  payload: {
    ownerKey: string; delivery?: { adminMessageId?: string }; revision: number; purpose: string; launch: { taskId: string; graphExecution?: { executionId: string }; graphReview?: { nodeId: string }; participants: { agentName: string; role: string; executionBackend: string; gatewayId: string }[] };
    resources: { path: string; canonicalPath: string; access: 'read' | 'write'; device: string; inode: string }[];
    scope: 'task' | 'project'; projectPath?: string;
    application: { state: string; detail?: string; runId?: string; eventId?: string };
  };
};

const approval: Approval = {
  id: 'approval-1', status: 'pending', requesterOpenId: 'requester', requesterChatId: 'requester-chat',
  cardMessageId: null, expiresAt: null,
  payload: {
    ownerKey: 'user:fixture', revision: 1, purpose: '读取样本并修改适配器', launch: { taskId: 'task-1', participants: [
      { agentName: 'Codex', role: 'implementer', executionBackend: 'platform_local', gatewayId: 'local' },
    ] },
    resources: [
      { path: '/data/reader', canonicalPath: '/data/reader', access: 'read', device: '1', inode: '2' },
      { path: '/data/mold', canonicalPath: '/data/mold', access: 'write', device: '1', inode: '3' },
    ],
    scope: 'task', projectPath: '/data/project', application: { state: 'waiting' },
  },
};

const sends: { receiveId: string; threadRootMessageId?: string; uuid?: string; card: object }[] = [];
const patches: { messageId: string; card: object }[] = [];
const decisions: { action: string; revision: number; resources?: object[]; scope?: string }[] = [];
const reconciled: string[] = [];
let actor = 'admin';

const mocks: Record<string, object> = {
  '@/lib/feishu-access-approval': { isFeishuAdmin: (id: string) => id === actor && actor === 'admin' },
  '@/lib/feishu-api': {
    resolveFeishuMessageTarget: (binding: { chatId: string; rootMessageId: string }) => ({
      receiveId: binding.chatId, receiveIdType: 'chat_id', threadRootMessageId: binding.rootMessageId,
    }),
    sendFeishuInteractiveMessage: async (args: { receiveId: string; card: object; uuid?: string }) => {
      sends.push(args); return `message-${sends.length}`;
    },
  },
  '@/lib/feishu-task-entry-api': { updateFeishuTaskEntryCard: async (messageId: string, card: object) => {
    patches.push({ messageId, card });
  } },
  '@/lib/prisma': { prisma: {
    feishuConversationBinding: { findFirst: async () => ({ chatId: 'task-group', rootMessageId: 'task-root', threadId: 'thread' }) },
    feishuAdminApproval: { updateMany: async ({ data }: { data: { cardMessageId: string } }) => {
      approval.cardMessageId = data.cardMessageId; return { count: 1 };
    } },
  } },
  './delivery': { resourceTaskBinding: async () => ({ chatId: 'task-group', rootMessageId: 'task-root', threadId: 'thread' }) },
  '../feishu-card-markdown': { boundFeishuCardText: (text: string) => text },
  '../redact-sensitive': { redactSensitiveText: (text: string) => text },
  './access': {
    recordResourceDelivery: async (_id: string, delivery: { adminMessageId: string }) => { approval.payload.delivery = delivery; },
    getResourceApproval: async () => approval,
    decideResourceAccess: async (args: { actorOpenId: string; action: string; revision: number; resources?: Approval['payload']['resources']; scope?: 'task' | 'project' }) => {
      assert.equal(args.actorOpenId, 'admin');
      assert.equal(args.revision, approval.payload.revision);
      decisions.push(args);
      if (args.action === 'replace') {
        approval.payload.revision++;
        approval.payload.resources = args.resources!.map((resource, index) => ({ ...resource, canonicalPath: resource.path, device: '1', inode: String(index) }));
        approval.payload.scope = args.scope!;
      } else if (args.action === 'approve') approval.status = 'approved';
      else if (args.action === 'revoke') { approval.status = 'revoked'; approval.payload.application.state = 'revoking'; }
      else approval.status = 'denied';
      return approval;
    },
  },
  './retry': { retryResourceApplication: async () => approval },
  './reconcile': { reconcileResourceApprovals: async (id: string) => { reconciled.push(id); } },
};

const source = readFileSync(path.join(__dirname, '../src/lib/task-resources/cards.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const exportsForTest: Record<string, (...args: any[]) => any> = {};
new Function('require', 'exports', compiled)((name: string) => {
  assert.ok(mocks[name], `Unexpected runtime import: ${name}`);
  return mocks[name];
}, exportsForTest);
const { publishResourceApproval, handleResourceApprovalAction, buildResourceApprovalCard } = exportsForTest;
const action = (verb: string, revision = approval.payload.revision, formValue?: Record<string, unknown>, openId = 'admin') =>
  handleResourceApprovalAction({ cmd: `resource-approval:${verb}:${approval.id}:${revision}`, openId,
    messageId: 'message-1', chatId: 'task-group', formValue });

async function main() {
  process.env.FEISHU_ADMIN_OPEN_ID = 'admin';
  await publishResourceApproval(approval.id);
  assert.equal(approval.cardMessageId, 'message-1');
  assert.deepEqual(sends.map(send => [send.receiveId, send.threadRootMessageId, send.uuid]), [
    ['task-group', 'task-root', 'resource-approval-approval-1-task'],
    ['admin', undefined, 'resource-approval-approval-1-admin'],
  ]);
  assert.match(JSON.stringify(buildResourceApprovalCard(approval)), /批准并继续/);
  assert.match(JSON.stringify(buildResourceApprovalCard(approval)), /目录尚未挂载/);

  const unauthorized = await action('approve', 1, undefined, 'other');
  assert.equal(unauthorized?.toast.type, 'warning');
  assert.equal(decisions.length, 0);
  assert.equal((await action('edit'))?.toast.type, 'success');
  assert.match(JSON.stringify(patches.at(-1)?.card), /resource_1/);
  assert.equal((await action('replace', 1, { resource_0: 'write', resource_1: 'read', resource_scope: 'project' }))?.toast.type, 'warning');
  assert.equal(decisions.length, 0, 'The card cannot upgrade a readonly directory');
  assert.equal((await action('replace', 1, { resource_0: 'remove', resource_1: 'remove', resource_scope: 'task' }))?.toast.type, 'warning');
  assert.equal((await action('replace', 1, { resource_0: 'remove', resource_1: 'read', resource_scope: 'project' }))?.toast.type, 'success');
  assert.deepEqual(decisions[0], { id: approval.id, revision: 1, actorOpenId: 'admin', action: 'replace',
    resources: [{ path: '/data/mold', access: 'read' }], scope: 'project' });
  assert.equal(approval.payload.revision, 2);
  assert.equal(approval.status, 'pending');
  assert.match(JSON.stringify(patches.at(-1)?.card), /同项目任务复用/);
  assert.equal((await action('approve', 1))?.toast.type, 'warning');
  assert.equal(decisions.length, 1);
  assert.equal((await action('approve'))?.toast.type, 'success');
  assert.deepEqual(reconciled, [approval.id]);
  assert.match(JSON.stringify(patches.at(-1)?.card), /等待当前执行安全停止/);
  assert.doesNotMatch(JSON.stringify(patches.at(-1)?.card), /目录已生效/);
  assert.equal((await action('revoke'))?.toast.type, 'success');
  assert.deepEqual(reconciled, [approval.id, approval.id]);
  assert.match(JSON.stringify(patches.at(-1)?.card), /正在停止/);
  for (const role of ['graphExecution', 'graphReview'] as const) {
    approval.status = 'pending';
    approval.payload.application = { state: 'waiting' };
    if (role === 'graphExecution') approval.payload.launch.graphExecution = { executionId: 'execution' };
    else approval.payload.launch.graphReview = { nodeId: 'node' };
    assert.equal((await action('approve'))?.toast.type, 'success');
    assert.deepEqual(reconciled, [approval.id, approval.id], 'Graph preparation must use the coordinator host configuration, never the Feishu callback process');
    approval.payload.application = { state: 'failed', detail: 'preparation failed' };
    assert.match(JSON.stringify(buildResourceApprovalCard(approval)), /重试准备与接续/);
    assert.equal((await action('retry'))?.toast.type, 'success');
    assert.deepEqual(reconciled, [approval.id, approval.id]);
    approval.payload.application.eventId = 'already-admitted';
    assert.doesNotMatch(JSON.stringify(buildResourceApprovalCard(approval)), /重试准备与接续/);
    delete approval.payload.launch[role];
  }
  approval.payload.application = { state: 'waiting', detail: 'fixed input capacity exceeded' };
  assert.match(JSON.stringify(buildResourceApprovalCard(approval)), /fixed input capacity exceeded/);
  console.log('Resource card publication, revisioned edit preview, admin authorization and truthful application status passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
