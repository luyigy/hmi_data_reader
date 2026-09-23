import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { parseFeishuCommand } from '../src/lib/feishu-command-parser';
import { parseFeishuMessage } from '../src/lib/feishu-webhook';
import { buildFeishuTopicIdentity } from '../src/lib/feishu-topic-reply';

const requireLocal = createRequire(__filename);
const restores: (() => void)[] = [];
function stub(name: string, exports: object) {
  const key = requireLocal.resolve(name);
  const old = requireLocal(key);
  requireLocal.cache[key]!.exports = exports;
  restores.push(() => { requireLocal.cache[key]!.exports = old; });
}
let enabled = true, blocked = false, allowed = true;
const records = new Map<string, any>();
stub('../src/lib/feishu-task-binding', { isFeishuTaskIsolationEnabled: async () => enabled });
stub('../src/lib/feishu-access-approval', {
  checkFeishuDirectMessageAccess: async () => allowed,
  commandRequestsFullAccess: () => false,
});
stub('../src/lib/feishu-task-broadcast', { publishFeishuGroupBroadcast: async (args: any) => {
  const existing = records.get(args.sourceMessageId);
  const broadcast = existing || { ...args, id: 'broadcast-id', sequence: 1, targets: [{}, {}] };
  records.set(args.sourceMessageId, broadcast);
  return { created: !existing, broadcast };
} });
const findAccess = prisma.feishuUserAccess.findUnique;
prisma.feishuUserAccess.findUnique = (async () => blocked ? { status: 'blocked' } : null) as any;
const oldApp = process.env.FEISHU_APP_ID;
process.env.FEISHU_APP_ID = 'app';

async function main() {
  const { handleFeishuCommand } = await import('../src/lib/feishu');
  const context = { chatId: 'group', chatType: 'group', senderOpenId: 'user', messageId: 'source' };
  const run = (text: string, extra = {}) => {
    const command = parseFeishuCommand({ text } as any)!;
    assert.ok(command);
    return handleFeishuCommand({ command, context: { ...context, ...extra }, baseUrl: 'http://localhost' });
  };
  const content = '第一行  "引号" --option=value\n第二行\n<at user_id="target">保留提及</at>';
  assert.deepEqual(parseFeishuCommand({ text: `/ap broadcast ${content}` } as any), { command: 'broadcast', args: [content], options: {} });
  assert.equal(parseFeishuCommand({ text: '普通闲聊 广播内容' } as any), null);
  assert.equal(parseFeishuCommand({ text: '/ap broadcaster test' } as any), null);
  assert.equal(parseFeishuCommand({ text: '@_user_1 /ap broadcast 公共标记' } as any)?.args[0], '公共标记');
  assert.match(await run('/ap broadcast   \n'), /不能为空/);
  for (const extra of [{ chatType: 'p2p' }, { threadId: 'thread' }, { rootId: 'root' }, { parentMessageId: 'parent' }]) {
    assert.match(await run('/ap broadcast notice', extra), /群主聊天区/);
  }
  for (const extra of [{ appId: 'foreign' }, { messageId: '' }, { senderOpenId: '' }]) {
    assert.match(await run('/ap broadcast notice', extra), /无法验证/);
  }
  blocked = true;
  assert.match(await run('/ap broadcast notice'), /无权/);
  blocked = false;
  allowed = false;
  assert.match(await run('/ap broadcast notice'), /无权/);
  allowed = true;
  enabled = false;
  assert.match(await run('/ap broadcast notice'), /已关闭/);
  assert.equal(records.size, 0);
  enabled = true;
  assert.match(await run(`/ap broadcast ${content}`), /目标任务 2 个/);
  assert.equal(records.get('source').content, content);
  assert.match(await run(`/ap broadcast ${content}`), /重复消息/);
  assert.equal(records.size, 1);
  const parsed = parseFeishuMessage({ header: { event_type: 'im.message.receive_v1' }, event: {
    sender: { sender_id: { open_id: 'user' } }, message: {
      chat_id: 'group', message_id: 'topic-source', chat_type: 'group', message_type: 'text',
      content: JSON.stringify({ text: '/ap broadcast topic notice' }), thread_id: 'thread', root_id: 'root', parent_id: 'parent',
    },
  } });
  assert.ok(parsed);
  assert.deepEqual(buildFeishuTopicIdentity(parsed), { threadId: 'thread', rootId: 'root', parentMessageId: 'parent' });
  assert.match(await run(parsed.text, buildFeishuTopicIdentity(parsed)), /群主聊天区/);
  assert.equal(records.size, 1);
  // Exercise the HTTP entry as well: losing topic fields here would publish.
  const api = requireLocal('../src/lib/feishu-api');
  const replies: string[] = [];
  stub('../src/lib/feishu-api', { ...api,
    addTypingReaction: async () => null,
    removeTypingReaction: async () => undefined,
    sendFeishuTextMessage: async (args: any) => { replies.push(args.text); return 'reply'; },
  });
  const webhook = requireLocal('../src/lib/feishu-webhook');
  stub('../src/lib/feishu-webhook', { ...webhook,
    validateFeishuRequestSignature: () => true,
    validateFeishuVerificationToken: () => true,
  });
  stub('../src/lib/feishu-message-trigger', { shouldTriggerFeishuMessage: () => true });
  const { POST } = await import('../src/app/api/feishu/webhook/route');
  const { NextRequest } = await import('next/server');
  const payload = { header: { event_type: 'im.message.receive_v1' }, event: {
    sender: { sender_id: { open_id: 'user' } }, message: {
      chat_id: 'group', message_id: 'http-topic', chat_type: 'group', message_type: 'text',
      content: JSON.stringify({ text: '/ap broadcast forbidden' }), thread_id: 'thread', root_id: 'root',
    },
  } };
  const response = await POST(new NextRequest('http://localhost/api/feishu/webhook', {
    method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' },
  }));
  assert.equal(response.status, 200);
  assert.match(replies[0], /群主聊天区/);
  assert.equal(records.size, 1, 'HTTP topic broadcast must not reach persistence');
  console.log('Broadcast command: raw body, dispatch, authorization, mode, topic boundaries, dedup and webhook identity passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  restores.reverse().forEach(restore => restore());
  prisma.feishuUserAccess.findUnique = findAccess;
  if (oldApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = oldApp;
  await prisma.$disconnect();
});
