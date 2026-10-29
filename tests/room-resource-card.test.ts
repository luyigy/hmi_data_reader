import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '../src/lib/prisma';
import { processLiveRoomDelivery } from '../src/lib/live-room-delivery-processing';
import { getHarnessAdapter } from '../src/lib/harness';
import { handleResourceApprovalAction } from '../src/lib/task-resources/cards';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL!).searchParams.get('schema') || '', /^task_graph_test_/);
  process.env.FEISHU_ADMIN_OPEN_ID = 'fixture-admin';
  const root = await mkdtemp(join(tmpdir(), 'room-resource-card-'));
  const cwd = join(root, 'workspace'), extra = join(root, 'extra');
  await Promise.all([cwd, extra].map(p => mkdir(p)));
  const loadModule = createRequire(__filename);
  const api = loadModule('../src/lib/feishu-api');
  const updates = loadModule('../src/lib/feishu-task-entry-api');
  const relay = loadModule('../src/lib/feishu-live-room-relay');
  const cards = new Map<string, object>();
  const originals = { send: api.sendFeishuInteractiveMessage, patch: updates.updateFeishuTaskEntryCard, relay: relay.relayLiveRoomMessageToFeishu };
  api.sendFeishuInteractiveMessage = async (args: { uuid: string; card: object }) => { cards.set(args.uuid, args.card); return args.uuid; };
  updates.updateFeishuTaskEntryCard = async (id: string, card: object) => { cards.set(id, card); };
  relay.relayLiveRoomMessageToFeishu = async () => {};
  const adapter = getHarnessAdapter('codex')!;
  const original = { execute: adapter.execute, resume: adapter.resume };
  const envelope = `<resource-request>${JSON.stringify({ purpose: 'Verify model import', resources: [{ path: extra, access: 'read' }] })}</resource-request>`;
  let prompt = '', mode = '', resumeCalls = 0;
  adapter.execute = adapter.resume = async args => {
    prompt = args.task.description || '';
    const native = `room-resource-native-${args.task.id}`;
    if ('sessionId' in args) {
      resumeCalls++;
      assert.equal(args.sessionId, native, 'second turn resumes the original native Session');
      assert.equal(args.continuationMessage, prompt);
    }
    await args.context.onSessionStarted?.({ sessionId: native, sessionKind: 'codex_thread', threadId: native });
    const stream = args.context.streamCallbacks?.onStdoutChunk;
    if (mode === 'legacy') {
      await stream?.(envelope);
      return { success: true, output: envelope, executionTime: 1 };
    }
    await stream?.('检查完成，申请补充目录。', { id: 'progress', phase: 'commentary' });
    const text = mode === 'example' ? '协议示例：' + envelope : envelope;
    await stream?.(text.slice(0, 20), { id: 'final', phase: 'final_answer' });
    await stream?.(text.slice(20), { id: 'final', phase: 'final_answer' });
    await stream?.(text, { id: 'final', phase: 'final_answer', operation: 'replace' });
    return { success: true, output: '检查完成。\n\n' + text, executionTime: 1 };
  };
  const taskIds: string[] = [], roomIds: string[] = [], bindingIds: string[] = [];
  try {
    for (mode of ['full', 'restricted', 'covered', 'legacy', 'example']) {
      const task = await prisma.task.create({ data: { name: mode, workingDirectory: cwd } }); taskIds.push(task.id);
      const room = await prisma.liveRoom.create({ data: { title: mode, sourceTaskId: task.id, workingDirectory: cwd } }); roomIds.push(room.id);
      const binding = await prisma.feishuConversationBinding.create({ data: { scopeKey: room.id, liveRoomId: room.id, appId: 'fixture', chatId: 'fixture-chat', chatType: 'group', senderOpenId: 'fixture-admin' } }); bindingIds.push(binding.id);
      const member = await prisma.liveRoomMember.create({ data: { roomId: room.id, displayName: 'codex', harnessType: 'codex', backend: 'platform_local', memberType: 'local_agent', runtimeAgentId: 'codex', canReply: true,
        acpxPermissionConfig: JSON.stringify({ profile: ['full', 'legacy'].includes(mode) ? 'full_access' : 'dev_local', sandboxMode: ['full', 'legacy'].includes(mode) ? 'danger-full-access' : 'workspace-write', networkAccess: 'enabled', approvalPolicy: 'never', writableRoots: mode === 'covered' ? [cwd, extra] : [cwd] }) } });
      const message = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: 'Verify import', metadata: JSON.stringify({ feishuBindingId: binding.id }) } });
      const delivery = await prisma.liveRoomDelivery.create({ data: { roomMessageId: message.id, targetMemberId: member.id } });
      await processLiveRoomDelivery({ deliveryId: delivery.id, roomId: room.id, roomMessageId: message.id, targetMemberId: member.id, chainDepth: 0 });
      const saved = await prisma.feishuTurnCard.findFirstOrThrow({ where: { sourceMessageId: message.id, memberId: member.id } });
      const result = await prisma.liveRoomDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      assert.equal(result.deliveryStatus, 'delivered', result.fallbackReason || 'delivery must complete');
      assert.equal(saved.terminal, true);
      const card = JSON.parse(saved.cardJson!) as { elements: Array<{ tag: string; content?: string }> };
      const reply = card.elements.find(e => e.tag === 'markdown')!.content!;
      const approvals = await prisma.feishuAdminApproval.findMany({ where: { kind: 'task_resources', payloadJson: { contains: task.id } } });
      if (mode === 'example') {
        assert.equal(reply, '协议示例：' + envelope);
        assert.equal(approvals.length, 0);
      } else {
        assert.doesNotMatch(reply, /resource-request/, 'terminal card must show the platform resource result instead of raw JSON');
        assert.deepEqual(cards.get(saved.messageId!), card, 'durable and sent card agree');
        if (mode === 'restricted') {
          assert.equal(approvals.length, 1);
          assert.match(reply, /资源申请.*已提交/);
          const approvalCard = JSON.stringify(cards.get(approvals[0].cardMessageId!));
          assert.match(approvalCard, /批准并继续/); assert.match(approvalCard, /拒绝/); assert.match(approvalCard, /调整范围/);
          const denied = await handleResourceApprovalAction({ cmd: `resource-approval:deny:${approvals[0].id}:1`, openId: 'fixture-admin', messageId: approvals[0].cardMessageId! });
          assert.equal(denied?.toast.type, 'success');
          assert.equal((await prisma.feishuAdminApproval.findUniqueOrThrow({ where: { id: approvals[0].id } })).status, 'denied');
        } else {
          assert.equal(approvals.length, 0);
          assert.match(reply, /已在当前授权范围内/);
          if (mode === 'full') assert.match(prompt, /Full Access[\s\S]*不.*仅因.*仓库外.*申请/);
        }
      }
      if (mode === 'full' || mode === 'covered') {
        const nextMessage = await prisma.liveRoomMessage.create({ data: { roomId: room.id, messageType: 'user', content: 'Continue verifying the model', metadata: JSON.stringify({ feishuBindingId: binding.id }) } });
        const nextDelivery = await prisma.liveRoomDelivery.create({ data: { roomMessageId: nextMessage.id, targetMemberId: member.id } });
        const before = resumeCalls;
        await processLiveRoomDelivery({ deliveryId: nextDelivery.id, roomId: room.id, roomMessageId: nextMessage.id, targetMemberId: member.id, chainDepth: 0 });
        const nextResult = await prisma.liveRoomDelivery.findUniqueOrThrow({ where: { id: nextDelivery.id } });
        assert.equal(nextResult.deliveryStatus, 'delivered', nextResult.fallbackReason || 'resume must complete');
        assert.equal(resumeCalls, before + 1, 'must exercise adapter.resume, not a new Session');
        assert.match(prompt, /Continue verifying the model/);
        if (mode === 'full') assert.match(prompt, /本次运行已获 Full Access[\s\S]*不要仅因目录位于仓库外/, 'resumed native prompt must contain the current permission correction');
        else assert.match(prompt, /需要当前任务尚未授权的额外目录/, 'restricted resume retains resource approval instructions');
        const nextCard = await prisma.feishuTurnCard.findFirstOrThrow({ where: { sourceMessageId: nextMessage.id, memberId: member.id } });
        assert.match(nextCard.cardJson!, /已在当前授权范围内/);
      }
      console.log(`PASS ${mode}: actual Delivery/Runner, durable card, resource policy and buttons`);
    }
  } finally {
    adapter.execute = original.execute; adapter.resume = original.resume;
    api.sendFeishuInteractiveMessage = originals.send; updates.updateFeishuTaskEntryCard = originals.patch; relay.relayLiveRoomMessageToFeishu = originals.relay;
    await prisma.feishuAdminApproval.deleteMany({ where: { kind: 'task_resources', payloadJson: { contains: root } } });
    await prisma.feishuTurnCard.deleteMany({ where: { bindingId: { in: bindingIds } } });
    await prisma.feishuConversationBinding.deleteMany({ where: { id: { in: bindingIds } } });
    await prisma.liveRoom.deleteMany({ where: { id: { in: roomIds } } });
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    await rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
