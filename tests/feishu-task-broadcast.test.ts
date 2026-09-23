import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  confirmFeishuTaskBinding, recordFeishuTaskRoot, reserveFeishuTaskBinding, setFeishuTaskIsolation,
} from '../src/lib/feishu-task-binding';
import { listFeishuGroupBroadcasts, publishFeishuGroupBroadcast } from '../src/lib/feishu-task-broadcast';

const scope = { appId: 'test-app', chatId: 'test-group' };
const migration = '20260923113000_add_feishu_group_broadcasts';

async function main() {
  // A fresh process proves recovery does not depend on module memory.
  if (process.argv[2] === '--recover') {
    const db = new PrismaClient();
    try {
      const rows = await listFeishuGroupBroadcasts(scope, db);
      assert.deepEqual(rows.map(r => [r.sequence, r.targets.length]), [[1, 2], [2, 3], [3, 3]]);
      assert.equal(rows.every(r => r.targets.every(t => t.chatId === scope.chatId && t.appId === scope.appId)), true);
      assert.equal(await db.liveRoomMessage.count(), 0, 'broadcast storage never writes task rooms');
    } finally { await db.$disconnect(); }
    return;
  }
  const admin = new PrismaClient(); // Prisma loads the configured URL; never log it.
  const schema = `test_feishu_broadcast_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', schema);
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  const apply = async (name: string) => {
    const sql = readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8');
    // These migrations contain plain DDL, with no procedural bodies.
    for (const statement of sql.replace(/--[^\n]*/g, '').split(';').filter(s => s.trim())) {
      await db.$executeRawUnsafe(statement);
    }
  };
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  try {
    for (const name of readdirSync('prisma/migrations').sort()) {
      if (name >= '20260722160000_postgresql_baseline' && name <= migration) await apply(name);
    }
    const createTask = async (label: string, title: string, chat = scope) => {
      const request = await reserveFeishuTaskBinding({
        appId: chat.appId, chatId: chat.chatId, sourceMessageId: `create-${label}`,
        title, workingDirectory: '/tmp/task-test',
      }, db);
      await recordFeishuTaskRoot(chat, request.id, `root-${label}`, db);
      return confirmFeishuTaskBinding(chat, request.id, {
        chatId: chat.chatId, threadId: `thread-${label}`, rootMessageId: `root-${label}`,
      }, db);
    };
    const publish = (sourceMessageId: string, content: string, chat = scope) =>
      publishFeishuGroupBroadcast({
        appId: chat.appId, chatId: chat.chatId, sourceMessageId, senderOpenId: 'ou-admin', content,
      }, db);

    // Mode off (missing settings row) rejects new broadcasts.
    await assert.rejects(publish('msg-1', 'public notice'), /disabled/);

    await setFeishuTaskIsolation(scope, true, db);
    const a = await createTask('A', 'Task A');
    const b = await createTask('B', 'Task B');
    const archived = await createTask('C', 'Task C');
    await db.liveRoom.update({ where: { id: archived.liveRoomId }, data: { status: 'archived' } });

    // Concurrent first publish (same source message) yields exactly one record.
    const races = await Promise.all(Array.from({ length: 5 }, () => publish('msg-1', '公开通知一：明天 10 点发布')));
    assert.equal(races.filter(r => r.created).length, 1);
    assert.equal(new Set(races.map(r => r.broadcast.id)).size, 1);
    const first = races.find(r => r.created)!;
    assert.equal(first.broadcast.sequence, 1);
    assert.deepEqual(
      first.broadcast.targets.map(t => t.bindingId).sort(),
      [a.id, b.id].sort(),
    );
    for (const target of first.broadcast.targets) {
      assert.equal(target.chatId, scope.chatId);
      assert.equal(target.appId, scope.appId);
      assert.ok(target.threadId && target.rootMessageId && target.liveRoomId);
    }

    assert.equal(await db.feishuGroupBroadcast.count(), 1);
    // A replay may not rewrite the original content or sender.
    await assert.rejects(publish('msg-1', 'tampered'), /conflicts/);
    await assert.rejects(publishFeishuGroupBroadcast({
      ...scope, sourceMessageId: 'msg-1', senderOpenId: 'ou-other', content: '公开通知一：明天 10 点发布',
    }, db), /conflicts/);

    // Tasks created later never join an already-published scope.
    const d = await createTask('D', 'Task D');
    const second = await publish('msg-2', '公开通知二：索引服务维护');
    assert.equal(second.created, true);
    assert.equal(second.broadcast.sequence, 2);
    assert.deepEqual(
      second.broadcast.targets.map(t => t.bindingId).sort(),
      [a.id, b.id, d.id].sort(),
    );
    assert.equal(first.broadcast.targets.some(t => t.bindingId === d.id), false, 'later task must not join scope 1');

    // Other groups and other apps never leak into this group's scope.
    const otherChat = { appId: scope.appId, chatId: 'other-group' };
    await setFeishuTaskIsolation(otherChat, true, db);
    await createTask('X', 'Task X', otherChat);
    const otherApp = { appId: 'other-app', chatId: scope.chatId };
    await setFeishuTaskIsolation(otherApp, true, db);
    await createTask('Y', 'Task Y', otherApp);
    const third = await publish('msg-3', '公开通知三：范围核验');
    assert.equal(third.broadcast.sequence, 3);
    assert.equal(third.broadcast.targets.every(t => t.chatId === scope.chatId && t.appId === scope.appId), true);
    assert.equal(third.broadcast.targets.some(t => t.threadId === 'thread-X' || t.threadId === 'thread-Y'), false);

    // Snapshot identity survives later binding/room changes.
    await db.feishuConversationBinding.delete({ where: { id: b.id } });
    const relisted = await listFeishuGroupBroadcasts(scope, db);
    assert.equal(relisted.find(r => r.sequence === 1)?.targets.length, 2, 'deleted binding keeps snapshot identity');

    // Mode off rejects NEW publishes but stored broadcasts stay readable.
    await setFeishuTaskIsolation(scope, false, db);
    await assert.rejects(publish('msg-4', 'should be rejected'), /disabled/);
    assert.equal((await listFeishuGroupBroadcasts(scope, db)).length, 3);
    // Broadcast storage never touches task private history.
    assert.equal(await db.liveRoomMessage.count(), 0);
    assert.equal(await db.liveRoomMemberSession.count(), 0);

    // Restart recovery from a fresh process.
    execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', __filename, '--recover'], {
      env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe',
    });

    console.log('Feishu group broadcasts: migration, dedup, scope snapshot, sequence, isolation and recovery passed');
  } finally {
    await db.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
