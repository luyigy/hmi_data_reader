import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

// S02 contract test: with two pre-provisioned task bindings in the same group,
// inputs, outputs, progress cards, commands and control lookups stay inside the
// owning thread/room; unknown or archived topics never reach the group room.
// Runs against an isolated random PostgreSQL schema built from the real
// migrations (same bootstrap as tests/feishu-task-binding.test.ts).

type SendCall = { kind: string; receiveId: string; receiveIdType: string; payload?: string };

async function main() {
  const scope = { appId: 'test-app', chatId: 'test-group' };
  const admin = new PrismaClient();
  const schema = `test_feishu_thread_loop_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', schema);
  // Point the shared src prisma client at the isolated schema BEFORE importing
  // any module that touches '@/lib/prisma'.
  process.env.DATABASE_URL = url.toString();
  const previousApp = process.env.FEISHU_APP_ID;
  process.env.FEISHU_APP_ID = scope.appId;

  const migration = '20260922180000_add_feishu_task_bindings';
  const apply = async (db: PrismaClient, name: string) => {
    const sql = readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8');
    for (const statement of sql.replace(/--[^\n]*/g, '').split(';').filter(s => s.trim())) {
      await db.$executeRawUnsafe(statement);
    }
  };

  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  try {
    const bootstrap = new PrismaClient({ datasourceUrl: url.toString() });
    const { readdirSync: readdirDirs } = await import('node:fs') as typeof import('node:fs');
    const migrationNames = readdirDirs('prisma/migrations', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of migrationNames) {
      if (name >= '20260722160000_postgresql_baseline') await apply(bootstrap, name);
    }
    await bootstrap.$disconnect();

    const {
      confirmFeishuTaskBinding, recordFeishuTaskRoot, reserveFeishuTaskBinding, setFeishuTaskIsolation,
    } = await import('@/lib/feishu-task-binding');
    const {
      ARCHIVED_FEISHU_TASK_HINT,
      ensureFeishuConversationBinding,
      getBoundLiveRoom,
      getBoundLiveRoomId,
      isFeishuRoomBoundToChat,
      isFeishuTopicRejection,
      postFeishuMessageToBoundLiveRoom,
      tryRelayNonCommandToLiveRoom,
      UNKNOWN_FEISHU_TOPIC_HINT,
    } = await import('@/lib/feishu-live-room');
    const { handleRoomCommand } = await import('@/lib/feishu-live-room-commands');
    const { handleStopAgentCommand } = await import('@/lib/feishu-agent-sessions');
    const { handleNewSessionCommand } = await import('@/lib/feishu-new-session');
    const { postLiveRoomMessage } = await import('@/lib/live-room-messages');
    const { attachLiveRoomProgress } = await import('@/lib/live-room-progress');
    const feishuApi = await import('@/lib/feishu-api');
    const { prisma } = await import('@/lib/prisma');

    // ---- fixture: legacy group + DM bindings, then task threads A and B ----
    const legacyRoom = await prisma.liveRoom.create({ data: { title: 'Legacy group' } });
    await prisma.$executeRaw`INSERT INTO "FeishuConversationBinding"
      ("id", "scopeKey", "chatId", "chatType", "liveRoomId", "updatedAt")
      VALUES ('legacy', 'feishu:group:test-group', 'test-group', 'group', ${legacyRoom.id}, CURRENT_TIMESTAMP)`;
    const dmRoom = await prisma.liveRoom.create({ data: { title: 'Legacy DM' } });
    await prisma.feishuConversationBinding.create({ data: {
      scopeKey: 'feishu:p2p:dm', chatId: 'dm', chatType: 'p2p', liveRoomId: dmRoom.id,
    } });
    await setFeishuTaskIsolation(scope, true);

    const createTask = async (source: string, title: string, thread: string, root: string) => {
      const request = await reserveFeishuTaskBinding({ ...scope, sourceMessageId: source, title, workingDirectory: '/tmp/thread-loop' });
      await recordFeishuTaskRoot(scope, request.id, root);
      const binding = await confirmFeishuTaskBinding(scope, request.id, { chatId: scope.chatId, threadId: thread, rootMessageId: root });
      return binding;
    };
    const taskA = await createTask('create-A', 'Task A', 'thread-A', 'root-A');
    const taskB = await createTask('create-B', 'Task B', 'thread-B', 'root-B');

    const contextFor = (thread: string, messageId: string) => ({
      appId: scope.appId, chatId: scope.chatId, chatType: 'group',
      senderOpenId: 'ou-user', messageId, threadId: thread,
    });

    // ---- capture every outbound Feishu call; nothing may hit the network ----
    const sends: SendCall[] = [];
    const feishuSends = feishuApi as {
      sendFeishuInteractiveMessage: (args: { receiveId: string; receiveIdType?: string; card: Record<string, unknown> }) => Promise<string | undefined>;
      sendFeishuTextMessage: (args: { receiveId: string; receiveIdType?: string; text: string }) => Promise<void>;
      sendFeishuLocalImageMessage: (args: { receiveId: string; receiveIdType?: string; filePath: string }) => Promise<string | undefined>;
    };
    const originalSends = {
      interactive: feishuSends.sendFeishuInteractiveMessage,
      text: feishuSends.sendFeishuTextMessage,
      image: feishuSends.sendFeishuLocalImageMessage,
    };
    feishuSends.sendFeishuInteractiveMessage = async ({ receiveId, receiveIdType, card }) => {
      sends.push({ kind: 'interactive', receiveId, receiveIdType: receiveIdType || 'chat_id', payload: String((card as { elements?: Array<{ content?: string }> }).elements?.[0]?.content || '') });
      return `om-${sends.length}`;
    };
    feishuSends.sendFeishuTextMessage = async ({ receiveId, receiveIdType, text }) => {
      sends.push({ kind: 'text', receiveId, receiveIdType: receiveIdType || 'chat_id', payload: text });
    };
    feishuSends.sendFeishuLocalImageMessage = async ({ receiveId, receiveIdType }) => {
      sends.push({ kind: 'image', receiveId, receiveIdType: receiveIdType || 'chat_id' });
      return `om-${sends.length}`;
    };

    // ---- input: dual-thread relay keeps A and B rooms isolated ----
    const relayA = await postFeishuMessageToBoundLiveRoom({
      context: contextFor('thread-A', 'om-a-1'),
      content: 'A-private-marker: alpha secret',
    });
    assert.equal(relayA.liveRoomId, taskA.liveRoomId);
    const relayB = await postFeishuMessageToBoundLiveRoom({
      context: contextFor('thread-B', 'om-b-1'),
      content: 'B-private-marker: beta secret',
    });
    assert.equal(relayB.liveRoomId, taskB.liveRoomId);

    const roomAMessages = () => prisma.liveRoomMessage.findMany({ where: { roomId: taskA.liveRoomId } });
    const roomBMessages = () => prisma.liveRoomMessage.findMany({ where: { roomId: taskB.liveRoomId } });
    assert.equal((await roomAMessages()).some(m => m.content.includes('alpha secret')), true);
    assert.equal((await roomBMessages()).some(m => m.content.includes('alpha secret')), false, 'A input must never leak into B room');
    assert.equal((await roomBMessages()).some(m => m.content.includes('beta secret')), true);
    assert.equal((await roomAMessages()).some(m => m.content.includes('beta secret')), false, 'B input must never leak into A room');
    const aMetadata = JSON.parse((await roomAMessages()).find(m => m.content.includes('alpha secret'))!.metadata!);
    assert.equal(aMetadata.feishuBindingId, taskA.id, 'posted message records the owning task binding');

    // ---- event replay: the same feishu message id must not create a second post ----
    const countBefore = (await roomAMessages()).length;
    const replay = await postFeishuMessageToBoundLiveRoom({
      context: contextFor('thread-A', 'om-a-1'),
      content: 'replayed duplicate should be dropped',
    });
    assert.equal(replay.liveRoomId, taskA.liveRoomId);
    assert.equal((await roomAMessages()).length, countBefore, 'replayed events are deduplicated by feishuMessageId');

    // ---- output: assistant relay from each room targets only its own thread ----
    await new Promise((resolve) => setTimeout(resolve, 150));
    sends.length = 0;
    await postLiveRoomMessage({
      roomId: taskA.liveRoomId,
      content: 'A answer: alpha result',
      messageType: 'assistant',
      metadata: { source: 'feishu', feishuBindingId: taskA.id, feishuChatId: scope.chatId },
    });
    await postLiveRoomMessage({
      roomId: taskB.liveRoomId,
      content: 'B answer: beta result',
      messageType: 'assistant',
      metadata: { source: 'feishu', feishuBindingId: taskB.id, feishuChatId: scope.chatId },
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(sends.some(s => s.receiveId === 'thread-A' && s.receiveIdType === 'thread_id' && s.payload?.includes('alpha result')), true, 'A answers go to thread A');
    assert.equal(sends.some(s => s.receiveId === 'thread-B' && s.receiveIdType === 'thread_id' && s.payload?.includes('beta result')), true, 'B answers go to thread B');
    assert.equal(sends.some(s => s.receiveId === 'thread-B' && s.payload?.includes('alpha result')), false, 'A answer must never land in thread B');
    assert.equal(sends.some(s => s.receiveId === 'thread-A' && s.payload?.includes('beta result')), false, 'B answer must never land in thread A');
    assert.equal(sends.some(s => s.receiveIdType === 'chat_id' && (s.payload?.includes('alpha result') || s.payload?.includes('beta result'))), false, 'task answers must not broadcast to the group chat');

    // ---- progress cards: attachLiveRoomProgress follows the room's binding ----
    sends.length = 0;
    const progressA = await attachLiveRoomProgress({
      room: { id: taskA.liveRoomId },
      participant: { id: 'member-a', displayName: 'Agent A', harnessType: 'codex' },
      sourceMessage: { metadata: JSON.stringify({ feishuBindingId: taskA.id, feishuChatId: scope.chatId }) },
    });
    progressA.progressTracker?.onSystemEvent('开始处理 A', '🚀');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(sends.some(s => s.receiveId === 'thread-A' && s.receiveIdType === 'thread_id'), true, 'progress card goes to thread A');
    assert.equal(sends.some(s => s.receiveId === 'thread-B'), false, 'progress card must not go to thread B');
    await progressA.dispose('A 完成', true);
    assert.equal(sends.some(s => s.receiveId === 'thread-A' && s.kind === 'interactive'), true, 'final card goes to thread A');

    // Forged metadata: a room A message claiming room B's binding id must not
    // redirect progress output into thread B.
    sends.length = 0;
    const progressForged = await attachLiveRoomProgress({
      room: { id: taskA.liveRoomId },
      participant: { id: 'member-a', displayName: 'Agent A', harnessType: 'codex' },
      sourceMessage: { metadata: JSON.stringify({ feishuBindingId: taskB.id, feishuChatId: scope.chatId }) },
    });
    progressForged.progressTracker?.onSystemEvent('开始处理（伪造归属）', '🚀');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(sends.every(s => s.receiveId === 'thread-A'), true, 'cross-room binding metadata is ignored and falls back to the room binding');
    await progressForged.dispose('完成', true);

    // ---- final card retry: failed PATCH must re-send inside the same thread ----
    sends.length = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({ code: 500, msg: 'patch failed' }) })) as unknown as typeof fetch;
    try {
      const tracker = new (await import('@/lib/feishu-progress')).FeishuProgressTracker({ chatId: scope.chatId, threadId: 'thread-A' });
      tracker.onToolEvent('Bash', 'echo hi', '🔨');
      await new Promise((resolve) => setTimeout(resolve, 250));
      const finalId = await tracker.finalize('retry summary', true);
      assert.ok(finalId, 'finalize returns the fallback card message id');
      assert.equal(sends.length >= 1 && sends.every(s => s.receiveId === 'thread-A' && s.receiveIdType === 'thread_id'), true, 'progress and retry channels stay inside the thread');
    } finally {
      globalThis.fetch = originalFetch;
    }

    // ---- commands and control lookups are thread scoped ----
    assert.equal(await getBoundLiveRoomId(contextFor('thread-A', 'om-a-2')), taskA.liveRoomId);
    assert.equal(await getBoundLiveRoomId({ ...contextFor('thread-B', 'om-b-2'), threadId: undefined, rootId: 'root-B' }), taskB.liveRoomId);
    assert.equal((await getBoundLiveRoom(contextFor('thread-A', 'om-a-3')))!.id, taskA.liveRoomId);

    const newSessionResult = await handleNewSessionCommand(
      { command: 'new-session', args: [], options: {} },
      contextFor('thread-B', 'om-b-4'),
    );
    assert.match(newSessionResult, /未绑定可继续的 live room/, 'new-session resolves the task B room');

    // Give both rooms a distinct agent member + backing task so stop proves the
    // scoped room (and stopping A never mentions B's member).
    const { syncLiveRoomSourceTask } = await import('@/lib/live-room-members');
    for (const [binding, name] of [[taskA, 'A-Agent'], [taskB, 'B-Agent']] as const) {
      await prisma.liveRoomMember.create({
        data: {
          roomId: binding.liveRoomId,
          memberType: 'agent',
          displayName: name,
          canReply: true,
          sortOrder: 1,
          presenceStatus: 'online',
          backend: 'platform_local',
          harnessType: 'codex',
        },
      });
      await syncLiveRoomSourceTask(binding.liveRoomId);
    }
    const stopA = await handleStopAgentCommand(
      { command: 'stop', args: [], options: {} },
      contextFor('thread-A', 'om-a-4'),
    );
    assert.match(stopA, /A-Agent/, 'stop resolves the task A room');
    const stopB = await handleStopAgentCommand(
      { command: 'stop', args: [], options: {} },
      contextFor('thread-B', 'om-b-5'),
    );
    assert.match(stopB, /B-Agent/, 'stop resolves the task B room');
    assert.doesNotMatch(stopA, /B-Agent/, 'stopping A never touches B\'s member');
    assert.doesNotMatch(stopB, /A-Agent/, 'stopping B never touches A\'s member');

    // add flows reuse the task room, never the group room
    const addFlow = await ensureFeishuConversationBinding({
      context: contextFor('thread-A', 'om-a-5'),
      selectedAgentIds: [],
    });
    assert.equal(addFlow.liveRoomId, taskA.liveRoomId);
    assert.equal(addFlow.created, false);
    assert.equal((await prisma.liveRoom.findUniqueOrThrow({ where: { id: legacyRoom.id } })).title, 'Legacy group');

    // /ap room never mutates or creates group-level bindings from inside a topic
    const roomCount = await prisma.liveRoom.count();
    const roomGuard = await handleRoomCommand(
      { command: 'room', args: [], options: {} },
      contextFor('thread-A', 'om-a-6'),
    );
    assert.match(roomGuard, /已绑定任务房间/);
    const roomGuardUnknown = await handleRoomCommand(
      { command: 'room', args: [], options: {} },
      contextFor('thread-unknown', 'om-x-6'),
    );
    assert.equal(roomGuardUnknown, UNKNOWN_FEISHU_TOPIC_HINT);
    assert.equal(await prisma.liveRoom.count(), roomCount, 'no rooms are created by topic room commands');

    // ---- unknown and archived topics never reach the group room ----
    const rejectsWith = async (fn: () => Promise<unknown>, expectedName: string, messagePattern: RegExp) => {
      try {
        await fn();
      } catch (error) {
        const candidate = error as { name?: string; message?: string };
        assert.equal(isFeishuTopicRejection(error), true, 'rejection must be identifiable as a topic rejection');
        assert.equal(candidate.name, expectedName);
        assert.match(candidate.message || '', messagePattern);
        return;
      }
      assert.fail(`expected rejection by ${expectedName}`);
    };
    await rejectsWith(() => getBoundLiveRoomId(contextFor('thread-unknown', 'om-x-1')), 'FeishuUnknownTopicError', /话题未绑定任务/);
    await rejectsWith(() => tryRelayNonCommandToLiveRoom({ context: contextFor('thread-unknown', 'om-x-2'), content: 'hi' }), 'FeishuUnknownTopicError', /话题未绑定任务/);
    await rejectsWith(() => handleStopAgentCommand({ command: 'stop', args: [], options: {} }, contextFor('thread-unknown', 'om-x-3')), 'FeishuUnknownTopicError', /话题未绑定任务/);
    await rejectsWith(() => getBoundLiveRoomId({ ...contextFor('thread-A', 'om-x-5'), threadId: undefined, parentMessageId: 'thread-A' }), 'FeishuUnknownTopicError', /话题未绑定任务/);
    assert.equal(await getBoundLiveRoomId({ ...contextFor('thread-A', 'om-x-4'), threadId: undefined, parentMessageId: 'root-A' }), taskA.liveRoomId, 'persisted entry roots still resolve');

    await prisma.liveRoom.update({ where: { id: taskB.liveRoomId }, data: { status: 'archived' } });
    await rejectsWith(() => getBoundLiveRoomId(contextFor('thread-B', 'om-b-7')), 'FeishuArchivedTaskError', /已归档/);
    const archivedGuard = await handleRoomCommand({ command: 'room', args: [], options: {} }, contextFor('thread-B', 'om-b-8'));
    assert.equal(archivedGuard, ARCHIVED_FEISHU_TASK_HINT);
    // existing task A keeps working while B is archived
    assert.equal(await getBoundLiveRoomId(contextFor('thread-A', 'om-a-7')), taskA.liveRoomId);
    await prisma.liveRoom.update({ where: { id: taskB.liveRoomId }, data: { status: 'active' } });

    // ---- card mapping: server-side room <-> chat validation ----
    assert.equal(await isFeishuRoomBoundToChat({ roomId: taskA.liveRoomId, chatId: scope.chatId }), true);
    assert.equal(await isFeishuRoomBoundToChat({ roomId: taskA.liveRoomId, chatId: 'oc-other-group' }), false, 'forged cross-room cards are rejected');
    assert.equal(await isFeishuRoomBoundToChat({ roomId: legacyRoom.id, chatId: scope.chatId }), true, 'legacy rows stay readable by the current app');

    // ---- legacy group / DM regression: no topic identity keeps old routing ----
    assert.equal(await getBoundLiveRoomId({ chatId: scope.chatId, chatType: 'group', senderOpenId: 'ou-user', messageId: 'om-g-1' }), legacyRoom.id);
    assert.equal(await getBoundLiveRoomId({ chatId: 'dm', chatType: 'p2p', senderOpenId: 'ou-user', messageId: 'om-d-1' }), dmRoom.id);
    sends.length = 0;
    assert.equal(await tryRelayNonCommandToLiveRoom({
      context: { chatId: scope.chatId, chatType: 'group', senderOpenId: 'ou-user', messageId: 'om-g-2' },
      content: 'legacy group message',
    }), true);
    assert.equal((await prisma.liveRoomMessage.findMany({ where: { roomId: legacyRoom.id } })).some(m => m.content.includes('legacy group message')), true);
    assert.equal(await tryRelayNonCommandToLiveRoom({
      context: { chatId: 'unbound-dm', chatType: 'p2p', senderOpenId: 'ou-user', messageId: 'om-d-2' },
      content: 'no binding',
    }), false);

    feishuSends.sendFeishuInteractiveMessage = originalSends.interactive;
    feishuSends.sendFeishuTextMessage = originalSends.text;
    feishuSends.sendFeishuLocalImageMessage = originalSends.image;
    console.log('Feishu task thread loop: dual-thread I/O, progress, control scoping, unknown/archived rejection and legacy regression passed');
  } finally {
    if (previousApp === undefined) delete process.env.FEISHU_APP_ID;
    else process.env.FEISHU_APP_ID = previousApp;
    await new PrismaClient({ datasourceUrl: url.toString() }).$disconnect().catch(() => undefined);
    await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.$disconnect();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
