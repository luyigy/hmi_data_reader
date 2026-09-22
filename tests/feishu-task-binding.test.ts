import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  confirmFeishuTaskBinding, isFeishuTaskIsolationEnabled, recordFeishuTaskRoot,
  reserveFeishuTaskBinding, resolveFeishuTaskConversation, setFeishuTaskIsolation,
} from '../src/lib/feishu-task-binding';

const scope = { appId: 'test-app', chatId: 'test-group' };
const migration = '20260922180000_add_feishu_task_bindings';

async function main() {
  // A fresh process proves recovery does not depend on module memory.
  if (process.argv[2] === '--recover') {
    const db = new PrismaClient();
    try {
      const result = await resolveFeishuTaskConversation({ ...scope, chatType: 'group', threadId: 'thread-A' }, db);
      assert.equal(result.kind, 'task');
      assert.equal('binding' in result && result.binding?.liveRoomId, process.argv[3]);
    } finally { await db.$disconnect(); }
    return;
  }
  const admin = new PrismaClient(); // Prisma loads the configured URL; never log it.
  const schema = `test_feishu_binding_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', schema);
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  const previousApp = process.env.FEISHU_APP_ID;
  process.env.FEISHU_APP_ID = scope.appId;
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
      if (name >= '20260722160000_postgresql_baseline' && name < migration) await apply(name);
    }
    const oldRoom = await db.liveRoom.create({ data: { title: 'Legacy group' } });
    await db.$executeRaw`INSERT INTO "FeishuConversationBinding"
      ("id", "scopeKey", "chatId", "chatType", "liveRoomId", "updatedAt")
      VALUES ('legacy', 'feishu:group:test-group', 'test-group', 'group', ${oldRoom.id}, CURRENT_TIMESTAMP)`;
    await apply(migration);
    const legacy = await resolveFeishuTaskConversation({ ...scope, chatType: 'group' }, db);
    assert.equal(legacy.kind, 'group_entry');
    assert.equal('binding' in legacy && legacy.binding?.liveRoomId, oldRoom.id);
    assert.equal((await db.feishuConversationBinding.findUniqueOrThrow({ where: { id: 'legacy' } })).threadId, null);
    await db.feishuConversationBinding.create({ data: {
      scopeKey: 'feishu:p2p:dm', chatId: 'dm', chatType: 'p2p', liveRoomId: oldRoom.id,
    } });
    const dm = await resolveFeishuTaskConversation({ ...scope, chatId: 'dm', chatType: 'p2p' }, db);
    assert.equal('binding' in dm && dm.binding?.liveRoomId, oldRoom.id);
    const foreignEntry = await resolveFeishuTaskConversation({ ...scope, appId: 'other-app', chatType: 'group' }, db);
    assert.equal('binding' in foreignEntry && foreignEntry.binding, null);
    assert.equal(await isFeishuTaskIsolationEnabled(scope, db), false);
    const args = { ...scope, sourceMessageId: 'create-A', title: 'Task A', workingDirectory: '/tmp/task-test' };
    await assert.rejects(reserveFeishuTaskBinding(args, db), /disabled/);
    await setFeishuTaskIsolation(scope, true, db);
    const requests = await Promise.all(Array.from({ length: 5 }, () => reserveFeishuTaskBinding(args, db)));
    assert.equal(new Set(requests.map(r => r.id)).size, 1);
    const request = requests[0];
    assert.equal(await db.liveRoom.count(), 1, 'failed card send leaves only the legacy room');
    await assert.rejects(reserveFeishuTaskBinding({ ...args, title: 'conflict' }, db), /conflicts/);
    const messageA = { chatId: scope.chatId, threadId: 'thread-A', rootMessageId: 'root-A' };
    await assert.rejects(confirmFeishuTaskBinding(scope, request.id, messageA, db), /Unverified/);
    await recordFeishuTaskRoot(scope, request.id, 'root-A', db);
    await recordFeishuTaskRoot(scope, request.id, 'root-A', db);
    await assert.rejects(recordFeishuTaskRoot(scope, request.id, 'other', db), /conflicting/);
    await assert.rejects(confirmFeishuTaskBinding(scope, request.id, { ...messageA, chatId: 'other' }, db), /Cross-chat/);
    const bindings = await Promise.all(Array.from({ length: 5 }, () => confirmFeishuTaskBinding(scope, request.id, messageA, db)));
    assert.equal(new Set(bindings.map(b => b.liveRoomId)).size, 1);
    const a = bindings[0];
    const requestB = await reserveFeishuTaskBinding({ ...args, sourceMessageId: 'create-B', title: 'Task B' }, db);
    await assert.rejects(recordFeishuTaskRoot(scope, requestB.id, 'root-A', db));
    await recordFeishuTaskRoot(scope, requestB.id, 'root-B', db);
    await assert.rejects(confirmFeishuTaskBinding(scope, requestB.id, { ...messageA, rootMessageId: 'root-B' }, db));
    assert.equal(await db.liveRoom.count(), 2, 'uniqueness conflict rolls back nested room creation');
    const b = await confirmFeishuTaskBinding(scope, requestB.id, { ...messageA, threadId: 'thread-B', rootMessageId: 'root-B' }, db);
    assert.notEqual(a.liveRoomId, b.liveRoomId);
    assert.equal(await db.liveRoomMessage.count(), 0);
    assert.equal(await db.liveRoomMemberSession.count(), 0);
    assert.equal(await db.liveRoomMember.count(), 0, 'no implicit group member/session inheritance');
    for (const identity of [{ threadId: 'thread-A' }, { rootMessageId: 'root-A' }, { parentMessageId: 'root-A' }]) {
      const result = await resolveFeishuTaskConversation({ ...scope, chatType: 'group', ...identity }, db);
      assert.equal(result.kind, 'task');
      assert.equal('binding' in result && result.binding?.id, a.id);
    }
    for (const identity of [
      { threadId: 'unknown' }, { parentMessageId: 'thread-A' }, { rootMessageId: 'unknown' },
      { threadId: 'unknown', rootMessageId: 'root-A' },
      { threadId: 'thread-A', rootMessageId: 'root-B' }, { threadId: 'thread-A', parentMessageId: 'root-B' },
      { chatId: 'other-group', threadId: 'thread-A' }, { appId: 'other-app', threadId: 'thread-A' },
    ]) {
      assert.equal((await resolveFeishuTaskConversation({ ...scope, chatType: 'group', ...identity }, db)).kind, 'unknown_topic');
    }
    for (const other of [{ ...scope, chatId: 'other-group' }, { ...scope, appId: 'other-app' }]) {
      await setFeishuTaskIsolation(other, true, db);
      const r = await reserveFeishuTaskBinding({ ...args, ...other }, db);
      await recordFeishuTaskRoot(other, r.id, 'root-A', db);
      const binding = await confirmFeishuTaskBinding(other, r.id, { ...messageA, chatId: other.chatId }, db);
      assert.notEqual(binding.liveRoomId, a.liveRoomId);
    }
    const pending = await reserveFeishuTaskBinding({ ...args, sourceMessageId: 'pending' }, db);
    await recordFeishuTaskRoot(scope, pending.id, 'root-pending', db);
    await setFeishuTaskIsolation(scope, false, db);
    await assert.rejects(confirmFeishuTaskBinding(scope, pending.id, {
      chatId: scope.chatId, threadId: 'thread-pending', rootMessageId: 'root-pending',
    }, db), /disabled/);
    await assert.rejects(reserveFeishuTaskBinding({ ...args, sourceMessageId: 'create-C' }, db), /disabled/);
    assert.equal((await resolveFeishuTaskConversation({ ...scope, chatType: 'group', threadId: 'thread-A' }, db)).kind, 'task');
    assert.equal((await confirmFeishuTaskBinding(scope, request.id, messageA, db)).id, a.id);
    execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', __filename, '--recover', a.liveRoomId], {
      env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe',
    });
    await db.liveRoom.update({ where: { id: a.liveRoomId }, data: { status: 'archived' } });
    assert.equal((await resolveFeishuTaskConversation({ ...scope, chatType: 'group', threadId: 'thread-A' }, db)).kind, 'archived_task');
    await setFeishuTaskIsolation(scope, true, db);
    assert.equal((await reserveFeishuTaskBinding(args, db)).bindingId, a.id);
    await assert.rejects(resolveFeishuTaskConversation({ ...scope, chatType: 'group', threadId: '' }, db), /invalid/);
    console.log('Feishu task bindings: migration, legacy, concurrency, conflicts, recovery, isolation and failure compensation passed');
  } finally {
    await db.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.$disconnect();
    if (previousApp === undefined) delete process.env.FEISHU_APP_ID;
    else process.env.FEISHU_APP_ID = previousApp;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
