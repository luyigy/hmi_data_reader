import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

// Real PostgreSQL + runner/harness input contract. Only the external model is
// stubbed. Each run uses a random schema and never contacts Feishu or an agent.
import type { AcpxParticipantRequest } from '../src/lib/acpx/types';
type ParticipantLike = AcpxParticipantRequest;

const scope = { appId: 'test-app', chatId: 'test-group' };

async function main() {
  // A fresh process proves delivery state is DB-driven, not module memory.
  if (process.argv[2] === '--recover') {
    const { prepareFeishuBroadcastPrompt } = await import('@/lib/feishu-task-broadcast');
    const { prisma } = await import('@/lib/prisma');
    const room = await prisma.liveRoom.findFirstOrThrow({ where: { title: 'Task A' }, include: { sourceTask: true, members: { orderBy: { sortOrder: 'asc' } } } });
    const { buildLiveRoomAcpxParticipant } = await import('@/lib/live-room-members');
    const batch = await prepareFeishuBroadcastPrompt({ taskId: room.sourceTask!.id, taskName: room.sourceTask!.name }, buildLiveRoomAcpxParticipant(room.members[0]));
    assert.equal(batch?.text, '', 'restart preserves the member consumption position');
    await prisma.$disconnect();
    return;
  }

  const admin = new PrismaClient();
  const schema = `test_feishu_broadcast_delivery_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', schema);
  process.env.DATABASE_URL = url.toString();

  const apply = async (db: PrismaClient, name: string) => {
    const sql = readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8');
    for (const statement of sql.replace(/--[^\n]*/g, '').split(';').filter(s => s.trim())) {
      await db.$executeRawUnsafe(statement);
    }
  };

  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  try {
    const bootstrap = new PrismaClient({ datasourceUrl: url.toString() });
    for (const name of readdirSync('prisma/migrations', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()) {
      if (name >= '20260722160000_postgresql_baseline') await apply(bootstrap, name);
    }
    await bootstrap.$disconnect();

    const {
      confirmFeishuTaskBinding, recordFeishuTaskRoot, reserveFeishuTaskBinding, setFeishuTaskIsolation,
    } = await import('@/lib/feishu-task-binding');
    const { publishFeishuGroupBroadcast } = await import('@/lib/feishu-task-broadcast');
    const {
      prepareFeishuBroadcastPrompt, ackFeishuBroadcastPrompt,
    } = await import('@/lib/feishu-task-broadcast');
    const { buildLiveRoomAcpxParticipant, syncLiveRoomSourceTask } = await import('@/lib/live-room-members');
    const { buildTaskRoomPromptContext, postTaskRoomMessage, postTaskRoomSessionResetMarker } = await import('@/lib/task-room');
    const { prisma } = await import('@/lib/prisma');

    await setFeishuTaskIsolation(scope, true);

    type Fixture = {
      liveRoomId: string;
      taskId: string;
      taskName: string;
      taskRoomId: string;
      participants: ParticipantLike[];
      memberIds: string[];
    };
    const setupTask = async (title: string, memberNames: string[], chat = scope): Promise<Fixture> => {
      const request = await reserveFeishuTaskBinding({
        appId: chat.appId, chatId: chat.chatId, sourceMessageId: `create-${title}`, title, workingDirectory: '/tmp/broadcast-delivery',
      });
      await recordFeishuTaskRoot(chat, request.id, `root-${title}`);
      const binding = await confirmFeishuTaskBinding(chat, request.id, {
        chatId: chat.chatId, threadId: `thread-${title}`, rootMessageId: `root-${title}`,
      });
      for (const [index, name] of memberNames.map((name, index) => [index, name] as const)) {
        await prisma.liveRoomMember.create({
          data: {
            roomId: binding.liveRoomId,
            memberType: 'agent',
            displayName: name,
            canReply: true,
            sortOrder: index + 1,
            presenceStatus: 'online',
            backend: 'platform_local',
            harnessType: 'codex',
          },
        });
      }
      await syncLiveRoomSourceTask(binding.liveRoomId);
      const room = await prisma.liveRoom.findUniqueOrThrow({
        where: { id: binding.liveRoomId },
        include: { sourceTask: true, members: { orderBy: { sortOrder: 'asc' } } },
      });
      const taskRoom = await prisma.chatRoom.findFirstOrThrow({
        where: { description: { contains: `TASK_ROOM:${room.sourceTask!.id}` } },
      });
      return {
        liveRoomId: binding.liveRoomId,
        taskId: room.sourceTask!.id,
        taskName: room.sourceTask!.name,
        taskRoomId: taskRoom.id,
        participants: room.members.map((member) => buildLiveRoomAcpxParticipant(member)),
        memberIds: room.members.map((member) => member.id),
      };
    };

    const taskA = await setupTask('Task A', ['A1', 'A2']);
    const taskB = await setupTask('Task B', ['B1', 'B2']);
    const prepare = (task: Fixture, index = 0) => prepareFeishuBroadcastPrompt(task, task.participants[index]);
    const publish = (id: string, content = id) => publishFeishuGroupBroadcast({ ...scope, sourceMessageId: id, senderOpenId: 'ou-admin', content });
    const first = await publish('public-1', '公开通知一');
    assert.equal(await prisma.message.count(), 0);
    assert.equal(await prisma.taskRun.count(), 0, 'publishing does not schedule a run');
    const a1 = await prepare(taskA);
    assert.ok(a1?.text.includes(first.broadcast.id));
    assert.equal(await prisma.feishuGroupBroadcastMemberDelivery.count(), 0, 'preparation never advances consumption');
    assert.deepEqual(await prepare(taskA), a1, 'failed attempt retries identical input');
    await Promise.all([ackFeishuBroadcastPrompt(a1), ackFeishuBroadcastPrompt(a1)]);
    assert.equal((await prepare(taskA))?.text, '');
    for (const [task, index] of [[taskA, 1], [taskB, 0], [taskB, 1]] as const) {
      const batch = await prepare(task, index);
      assert.ok(batch?.text.includes(first.broadcast.id), 'each member consumes independently');
      await ackFeishuBroadcastPrompt(batch);
    }
    assert.equal(await prisma.feishuGroupBroadcastMemberDelivery.count(), 4);
    const replay = await publish('public-1', '公开通知一');
    assert.equal(replay.broadcast.id, first.broadcast.id);
    execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', __filename, '--recover'], {
      env: { ...process.env, DATABASE_URL: url.toString(), TS_NODE_BASEURL: '.' }, stdio: 'pipe',
    });

    // A member-specific reset replays only that member's applicable public data.
    await postTaskRoomSessionResetMarker({ roomId: taskA.taskRoomId, sessionId: 'rotate-1', reason: `new-session:${taskA.memberIds[0]}` });
    assert.ok((await prepare(taskA))?.text.includes(first.broadcast.id));
    assert.equal((await prepare(taskA, 1))?.text, '');
    await ackFeishuBroadcastPrompt(await prepare(taskA));
    const newMember = await prisma.liveRoomMember.create({ data: {
      roomId: taskA.liveRoomId, memberType: 'agent', displayName: 'A3', canReply: true,
      backend: 'platform_local', harnessType: 'codex',
    } });
    assert.ok((await prepareFeishuBroadcastPrompt(taskA, buildLiveRoomAcpxParticipant(newMember)))?.text.includes(first.broadcast.id));

    // Frozen batch: a publication during execution is not acknowledged by that run.
    const second = await publish('public-2');
    const frozen = await prepare(taskA);
    const third = await publish('public-3');
    await ackFeishuBroadcastPrompt(frozen);
    const next = await prepare(taskA);
    assert.ok(next?.text.includes(third.broadcast.id));
    assert.equal(next?.text.includes(second.broadcast.id), false);
    await ackFeishuBroadcastPrompt(next);

    // Ordered backlog and full-text chunks, including a surrogate at the boundary.
    const longText = 'x'.repeat(3999) + '😀' + '尾'.repeat(4200);
    const long = await publish('long-public', longText);
    for (let i = 0; i < 11; i++) await publish(`backlog-${i}`);
    let reconstructed = '';
    const sequences: number[] = [];
    let earlierChunk: Awaited<ReturnType<typeof prepare>> = null;
    for (let round = 0; round < 8; round++) {
      const batch = await prepare(taskA);
      if (!batch?.text) break;
      if (!earlierChunk) earlierChunk = batch;
      const rows = batch.text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
      assert.ok(rows.reduce((n, r) => n + r.content.length, 0) <= 4000);
      for (const row of rows) {
        sequences.push(row.sequence);
        if (row.broadcastId === long.broadcast.id) reconstructed += row.content;
      }
      await ackFeishuBroadcastPrompt(batch);
    }
    assert.equal(reconstructed, longText, 'no truncation or lost surrogate between chunks');
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    await ackFeishuBroadcastPrompt(earlierChunk!);
    assert.equal((await prepare(taskA))?.text, '', 'late acknowledgement cannot move the offset backwards');

    const later = await setupTask('Later task', ['L1']);
    assert.equal((await prepare(later))?.text, '', 'new tasks do not read old public records');
    const otherScope = { appId: scope.appId, chatId: 'other-group' };
    await setFeishuTaskIsolation(otherScope, true);
    const other = await setupTask('Other group', ['X1'], otherScope);
    assert.equal((await prepare(other))?.text, '');
    const otherAppScope = { appId: 'other-app', chatId: scope.chatId };
    await setFeishuTaskIsolation(otherAppScope, true);
    const otherApp = await setupTask('Other app', ['Y1'], otherAppScope);
    assert.equal((await prepare(otherApp))?.text, '');
    await setFeishuTaskIsolation(scope, false);
    assert.ok((await prepare(taskB))?.text, 'mode off does not hide pending records');
    await assert.rejects(publish('disabled'), /disabled/i);
    await setFeishuTaskIsolation(scope, true);
    await prisma.liveRoom.update({ where: { id: later.liveRoomId }, data: { status: 'archived' } });
    const archive = await publish('after-archive');
    assert.equal(archive.broadcast.targets.some(t => t.liveRoomId === later.liveRoomId), false);

    // Capture actual adapter input through executeParticipant -> runner-harness.
    // Only the external model is replaced; DB, prompt builder, receipts are real.
    const { executeParticipant } = await import('@/lib/acpx/runner-participant');
    const { getHarnessAdapter } = await import('@/lib/harness');
    let captured = '';
    let fail = false;
    const adapter = getHarnessAdapter('codex')!;
    const runModel = async (input: string) => {
      captured = input;
      return { success: !fail, output: 'test complete', error: fail ? 'test model failed' : undefined, executionTime: 1 };
    };
    adapter.execute = async ({ task }) => runModel(task.description || '');
    adapter.resume = async ({ continuationMessage }) => runModel(continuationMessage);
    const run = async (fixture: Fixture, participant = fixture.participants[0]) => {
      const record = await prisma.taskRun.create({ data: {
        taskId: fixture.taskId, mode: 'acpx', orchestrationMode: 'single',
        participants: { create: { gatewayNameSnapshot: 'local', harnessType: participant.harnessType, role: 'custom', executionBackend: participant.executionBackend } },
      }, include: { participants: true } });
      return executeParticipant({ taskId: fixture.taskId, taskName: fixture.taskName, participants: [participant], orchestrationMode: 'single' }, record.id, record.participants[0].id, participant, [], null);
    };
    await postTaskRoomMessage({ roomId: taskA.taskRoomId, userId: 'task-room-user', userName: '用户', content: 'A-private-secret: continue original task' });
    const actual = await publish('actual-input', '保留原始公共通知');
    fail = true;
    assert.equal((await run(taskA)).status, 'failed');
    assert.ok(captured.includes(actual.broadcast.id));
    assert.ok(captured.includes('Latest task-room instruction (highest priority for this run):\nA-private-secret: continue original task'));
    assert.ok((await prepare(taskA))?.text.includes(actual.broadcast.id), 'model failure leaves broadcast pending');
    fail = false;
    assert.equal((await run(taskA)).status, 'completed');
    assert.equal((await prepare(taskA))?.text, '');
    const resumed = await publish('resumed-input');
    assert.equal((await run(taskA, { ...taskA.participants[0], resumeSessionId: 'codex-session', continuationMessage: 'continue via resume' })).status, 'completed');
    assert.ok(captured.startsWith('continue via resume'));
    assert.ok(captured.includes(resumed.broadcast.id), 'resume gets public context too');
    assert.equal((await run(taskB)).status, 'completed');
    assert.equal(captured.includes('A-private-secret'), false);

    const remoteRegistry = await import('@/lib/remote-node-registry');
    const remoteRunner = await import('@/lib/remote-harness/runner-executor');
    Object.assign(remoteRegistry, { getRemoteNodeWorkspace: async () => '/tmp/test' });
    Object.assign(remoteRunner, { executeRemoteRunnerTask: async ({ prompt }: { prompt: string }) => {
      captured = prompt;
      return { output: 'remote complete', filesModified: [], executionTime: 1, liveStreaming: true, sessionId: 'remote-1' };
    } });
    assert.equal((await run(taskA, { ...taskA.participants[0], executionBackend: 'remote_ssh', gatewayId: 'remote-node:test', harnessType: 'pi-agent', resumeSessionId: 'remote-1', continuationMessage: 'remote resume' })).status, 'completed');
    assert.ok(captured.startsWith('remote resume'));
    assert.ok(captured.includes(first.broadcast.id));
    const gateway = await import('@/lib/openclaw-client');
    Object.assign(gateway, {
      getOpenClawGatewayConfig: async () => ({}),
      createOpenClawResponse: async (_config: unknown, args: { input: string }) => {
        captured = args.input;
        return { output_text: 'gateway complete' };
      },
    });
    assert.equal((await run(taskA, { ...taskA.participants[0], executionBackend: 'gateway_openclaw', harnessType: 'openclaw' })).status, 'completed');
    assert.ok(captured.includes(first.broadcast.id));

    // Provider-backed sessions: acknowledge against returned session, fresh
    // fallback replays instead of inheriting the expired provider's receipts.
    const native = { ...taskA.participants[1], harnessType: 'claude' };
    const nativeFirst = await prepareFeishuBroadcastPrompt(taskA, native);
    await ackFeishuBroadcastPrompt(nativeFirst, 'provider-1');
    const nativeNext = await prepareFeishuBroadcastPrompt(taskA, { ...native, resumeSessionId: 'provider-1' });
    assert.equal(nativeNext?.receipts.some(r => r.targetId === nativeFirst?.receipts[0].targetId), false);
    assert.deepEqual(await prepareFeishuBroadcastPrompt(taskA, native), nativeFirst, 'fresh provider session replays its initial batch');
    assert.equal(await prisma.liveRoomMessage.count(), 0, 'no room relay or auto-wakeup');
    assert.equal(await prisma.message.count({ where: { userName: '用户（群广播）' } }), 0, 'public data never displaces latest private instruction');
    await prisma.$disconnect();
    console.log('PASS: real adapter input, resume, failures, snapshot ack, per-member/reset/restart, scope, ordered chunks and backlog');
  } finally {
    await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
