import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseFeishuCommand } from '../src/lib/feishu-command-parser';
import { prisma } from '../src/lib/prisma';

const localRequire = createRequire(__filename);
const originals: (() => void)[] = [];
function stubModule(name: string, exports: object) {
  const key = localRequire.resolve(name);
  const original = localRequire(key);
  localRequire.cache[key]!.exports = exports;
  originals.push(() => { localRequire.cache[key]!.exports = original; });
}
const savedEnv = { app: process.env.FEISHU_APP_ID, secret: process.env.FEISHU_APP_SECRET };
process.env.FEISHU_APP_ID = 'test-app';
process.env.FEISHU_APP_SECRET = 'test-secret';
let enabled = false, archived = false, failRecord = false, failSend = false, failPatch = false, failAdmin = false;
let creates = 0, confirmations = 0, rootSends = 0, replySends = 0;
const requests = new Map<string, any>();
const roots = new Map<string, any>();
const sentUuids: string[] = [];
let scopeMismatch = false;
stubModule('../src/lib/feishu-access-approval', { isFeishuAdmin: (id: string) => id === 'platform-admin', commandRequestsFullAccess: () => false });
stubModule('../src/lib/feishu-task-binding', {
  isFeishuTaskIsolationEnabled: async () => enabled,
  setFeishuTaskIsolation: async (_: unknown, value: boolean) => { enabled = value; },
  reserveFeishuTaskBinding: async (args: any) => {
    assert.ok(enabled);
    const old = Array.from(requests.values()).find(r => r.sourceMessageId === args.sourceMessageId);
    if (old) return old;
    const request = { ...args, id: `request-${requests.size}`, createdAt: new Date(), rootMessageId: null, bindingId: null };
    requests.set(request.id, request);
    return request;
  },
  recordFeishuTaskRoot: async (_: unknown, id: string, root: string) => {
    if (failRecord) { failRecord = false; throw new Error('database unavailable'); }
    requests.get(id).rootMessageId = root;
  },
  confirmFeishuTaskBinding: async (_: unknown, id: string, message: any) => {
    confirmations++;
    const request = requests.get(id);
    assert.equal(message.rootMessageId, request.rootMessageId);
    assert.ok(message.threadId);
    if (!request.bindingId) { creates++; request.bindingId = `room-${id}`; }
    return { liveRoomId: request.bindingId };
  },
});
const findRequest = prisma.feishuTaskBindingRequest.findFirst;
const findAccess = prisma.feishuUserAccess.findUnique;
const findRoom = prisma.liveRoom.findUniqueOrThrow;
prisma.feishuTaskBindingRequest.findFirst = (async ({ where }: any) => {
  const request = requests.get(where.id);
  return request?.chatId === where.chatId && request.appId === where.appId ? request : null;
}) as any;
prisma.feishuUserAccess.findUnique = (async () => null) as any;
prisma.liveRoom.findUniqueOrThrow = (async () => ({ status: archived ? 'archived' : 'active' })) as any;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (urlValue: any, init: any = {}) => {
  const url = String(urlValue);
  const body = init.body ? JSON.parse(init.body) : {};
  const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
  if (url.includes('/auth/')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'fake', expire: 7200 }));
  if (url.includes('/chats/')) {
    assert.ok(url.endsWith('user_id_type=open_id'));
    if (failAdmin) throw new Error('admin API unavailable');
    return ok({ owner_id: 'owner', user_manager_id_list: ['manager'] });
  }
  if (url.includes('receive_id_type=')) {
    rootSends++;
    assert.equal(body.receive_id, 'chat');
    assert.ok(body.uuid);
    sentUuids.push(body.uuid);
    const root = `root-${body.uuid}`;
    roots.set(root, roots.get(root) || { message_id: root, chat_id: 'chat' });
    if (failSend) { failSend = false; throw new Error('response lost'); }
    return ok({ message_id: root });
  }
  const rootId = url.split('/messages/')[1]?.split('/')[0];
  const root = roots.get(rootId);
  assert.ok(root);
  if (url.endsWith('/reply')) {
    replySends++;
    assert.equal(body.reply_in_thread, true);
    assert.ok(body.uuid.endsWith('-thread'));
    root.thread_id = `thread-${rootId}`;
    return ok({ ...root, root_id: rootId });
  }
  if (init.method === 'PATCH') {
    if (failPatch) { failPatch = false; throw new Error('patch failed'); }
    return ok({});
  }
  return ok({ items: [{ ...root, ...(scopeMismatch ? { chat_id: 'foreign' } : {}) }] });
}) as typeof fetch;

async function main() {
  const { handleFeishuTaskCommand } = await import('../src/lib/feishu-task-entry');
  const context = { chatId: 'chat', chatType: 'group', senderOpenId: 'user', messageId: 'source' };
  const run = (text: string, extra = {}) => {
    const command = parseFeishuCommand({ text } as any);
    assert.ok(command);
    return handleFeishuTaskCommand(command, { ...context, ...extra });
  };
  const { handleFeishuCommand } = await import('../src/lib/feishu');
  assert.match(await handleFeishuCommand({ command: parseFeishuCommand({ text: '/ap isolation' } as any)!, context, baseUrl: 'http://localhost' }), /已关闭/);
  assert.match(await run('/ap isolation'), /已关闭/);
  assert.match(await run('/ap task new --title=A --workdir=/tmp'), /已关闭/);
  assert.equal(creates, 0);
  assert.match(await run('/ap isolation on'), /仅经验证/);
  failAdmin = true;
  await assert.rejects(run('/ap isolation on'), /admin API/);
  assert.equal(enabled, false);
  failAdmin = false;
  for (const senderOpenId of ['owner', 'manager', 'platform-admin']) {
    assert.match(await run('/ap isolation on', { senderOpenId }), /已开启/);
    assert.match(await run('/ap isolation off', { senderOpenId }), /已有任务仍保持隔离/);
  }
  assert.match(await run('/ap isolation on', { appId: 'foreign' }), /无法验证/);
  assert.match(await run('/ap isolation on', { chatType: 'p2p' }), /群根会话/);
  assert.match(await run('/ap isolation on', { threadId: 'unknown' }), /群根会话/);
  await run('/ap isolation on', { senderOpenId: 'owner' });
  assert.match(await run('/ap task new --title=A'), /请明确/);
  failSend = true;
  assert.match(await run('/ap task new --title=A --workdir=/tmp'), /retry request-0/);
  assert.equal(creates, 0);
  failRecord = true;
  assert.match(await run('/ap task retry request-0'), /database unavailable/);
  assert.equal(creates, 0);
  failPatch = true;
  assert.match(await run('/ap task retry request-0'), /patch failed/);
  assert.equal(creates, 1);
  assert.match(await run('/ap task retry request-0'), /入口已就绪/);
  assert.equal(creates, 1);
  assert.equal(new Set(sentUuids).size, 1);
  assert.equal(replySends, 1);
  assert.match(await run('/ap task retry request-0', { chatId: 'foreign' }), /没有该任务/);
  scopeMismatch = true;
  const before = confirmations;
  assert.match(await run('/ap task retry request-0'), /不属于当前群/);
  assert.equal(confirmations, before);
  scopeMismatch = false;
  archived = true;
  assert.match(await run('/ap task retry request-0'), /已归档/);
  assert.equal(creates, 1);
  archived = false;
  await run('/ap isolation off', { senderOpenId: 'owner' });
  assert.match(await run('/ap task new --title=B --workdir=/tmp', { messageId: 'source-B' }), /已关闭/);
  assert.equal(requests.size, 1);
  await run('/ap isolation on', { senderOpenId: 'manager' });
  assert.match(await run('/ap task new --title=B --workdir=/tmp', { messageId: 'source-B' }), /入口已就绪/);
  assert.equal(creates, 2);
  requests.set('old', { ...requests.get('request-0'), id: 'old', createdAt: new Date(0), rootMessageId: null });
  const sends = rootSends;
  assert.match(await run('/ap task retry old'), /安全重试窗口/);
  assert.equal(rootSends, sends);
  console.log('Feishu S03 entry checks passed: auth, toggles, idempotent recovery, scope, archive, retry window');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  originals.reverse().forEach(restore => restore());
  prisma.feishuTaskBindingRequest.findFirst = findRequest;
  prisma.feishuUserAccess.findUnique = findAccess;
  prisma.liveRoom.findUniqueOrThrow = findRoom;
  globalThis.fetch = originalFetch;
  if (savedEnv.app === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = savedEnv.app;
  if (savedEnv.secret === undefined) delete process.env.FEISHU_APP_SECRET; else process.env.FEISHU_APP_SECRET = savedEnv.secret;
});
