const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const rows = Array.from({ length: 240 }, (_, i) => ({ id: String(i), roomId: 'room', createdAt: i, replyToMessageId: i === 230 ? 'request' : null }));
const prisma = { liveRoom: { findFirst: async () => ({ id: 'room' }) }, liveRoomMember: { findMany: async () => [] }, liveRoomMessage: { findMany: async ({ where, orderBy, take }) => rows.filter(r => r.roomId === where.roomId && (!where.replyToMessageId || r.replyToMessageId === where.replyToMessageId)).sort((a,b) => (orderBy.createdAt === 'desc' ? -1 : 1) * (a.createdAt-b.createdAt)).slice(0,take) } };
const context = { exports: {}, console, require: name => {
  if (name === 'next/server') return { NextResponse: { json: (data, options) => ({ data, status: options?.status || 200 }) } };
  if (name === '@/lib/prisma') return { prisma };
  if (name === '@/lib/auth-users') return { requireCurrentUser: async () => ({}), ownedByCurrentUser: () => ({}) };
  if (name === '@/lib/live-room') return {
    serializeLiveRoomMessage: x => x, ensureLiveRoomUserMember: async () => ({id:'user'}), syncLiveRoomSourceTask: async () => {},
    detectLiveRoomMentionAll: () => false, detectMentionedLiveRoomMembers: () => ({memberIds:[]}), mergeLiveRoomMentionedMemberIds: () => [],
    resolveLiveRoomMessageMetadata: x => x, postLiveRoomMessage: async () => rows.at(-1), listLiveRoomPendingReplies: async () => [],
  };
  if (name === '@/lib/live-room-delivery') return {};
  throw Error(name);
} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/live-rooms/[id]/messages/route.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText, context);
(async () => {
  const get = query => context.exports.GET({nextUrl: new URL('http://local/?'+query)}, {params:{id:'room'}});
  let result = await get('limit=30');
  assert.deepEqual(result.data.messages.map(x=>x.id), rows.slice(-30).map(x=>x.id));
  result = await get('limit=30&replyToMessageId=request');
  assert.deepEqual(result.data.messages.map(x=>x.id), ['230']);
  result = await context.exports.POST({json: async () => ({content:'hello', autoReply:false})}, {params:{id:'room'}});
  assert.equal(result.status, 201);
  assert.deepEqual(result.data.messages.map(x=>x.id), rows.slice(-120).map(x=>x.id));
  console.log('PASS: GET/POST latest window, chronological order, scoped reply filter');
})().catch(e => { console.error(e); process.exitCode=1; });
