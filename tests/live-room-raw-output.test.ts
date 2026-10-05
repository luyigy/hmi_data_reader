import assert from 'node:assert/strict';
import { attachLiveRoomProgress } from '../src/lib/live-room-progress';
import * as messages from '../src/lib/live-room-messages';
import * as api from '../src/lib/feishu-api';
import { prisma } from '../src/lib/prisma';

async function main() {
  const sent: any[] = [];
  const roomProgress: any[] = [];
  const cards = new Map<string, any>();
  (prisma as any).feishuConversationBinding.findUnique = async () => ({
    chatId: 'chat', threadId: 'thread', rootMessageId: 'root', liveRoomId: 'room',
  });
  (prisma as any).$queryRaw = async () => { throw new Error('must use exact binding'); };
  Object.assign(messages, { postLiveRoomMessage: async (message: any) => { roomProgress.push(message); } });
  Object.assign(api, {
    getFeishuTenantAccessToken: async () => 'test',
    sendFeishuTextMessage: async () => { throw new Error('must use one card'); },
    sendFeishuInteractiveMessage: async (message: any) => {
      sent.push(message);
      const id = `card-${sent.length}`;
      cards.set(id, message.card);
      return id;
    },
  });
  let failUpdates = false;
  globalThis.fetch = async (url: any, options: any) => {
    const card = JSON.parse(JSON.parse(options.body).content);
    assert.ok(Buffer.byteLength(options.body) < 30000, 'bounded card request');
    const id = String(url).split('/').at(-1)!;
    if (failUpdates) return new Response(JSON.stringify({ code: 1, msg: 'update failed' }), { status: 500 });
    assert.ok(cards.has(id), 'patch existing card');
    cards.set(id, card);
    return new Response(JSON.stringify({ code: 0 }));
  };
  const body = (card: any) => card.elements[0].content as string;
  const detail = (card: any) => {
    const panel = card.elements.find((element: any) => element.tag === 'collapsible_panel');
    assert.equal(panel.expanded, false);
    assert.match(panel.header.title.content, /系统信息/);
    assert.equal(panel.elements[0].text.tag, 'plain_text');
    return panel.elements[0].text.content as string;
  };
  const note = (card: any) => card.elements.find((element: any) => element.tag === 'note').elements[0].content as string;
  const args = { room: { id: 'room' }, participant: {
    id: 'agy', displayName: 'Antigravity', harnessType: 'antigravity',
  }, sourceMessage: { metadata: JSON.stringify({ feishuBindingId: 'binding' }) } };
  const progress = await attachLiveRoomProgress(args);
  assert.equal(sent.length, 1, 'create the card before any CLI output');
  assert.deepEqual(cards.get('card-1').header, {
    template: 'blue', title: { tag: 'plain_text', content: 'Antigravity · 执行中...' },
  });
  assert.match(body(cards.get('card-1')), /Antigravity 正在处理信息/);
  const emit = (event: unknown, newline = true) => progress.streamCallbacks.onStdoutChunk!(JSON.stringify(event) + (newline ? '\n' : ''));
  const chunk = JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: '正在检查中文😀。' } }) + '\n';
  progress.streamCallbacks.onStdoutChunk!(chunk.slice(0, 19));
  progress.streamCallbacks.onStdoutChunk!(chunk.slice(19));
  emit({ event: 'unknown_future_event', secret: 'hidden protocol' });
  progress.streamCallbacks.onStdoutChunk!('not json\nnull\n');
  for (const state of ['ACTIVE', 'DONE']) emit({ event: 'step_update', step_update: {
    step_index: 2, state, step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { command: 'echo sk-secret123' } },
  } });
  emit({ event: 'step_update', step_update: { step_type: 'function_call', function_name: 'Read', arguments: { path: '/private/file' } } });
  emit({ event: 'step_update', step_update: { step_type: 'function_result', result: 'secret tool payload' } });
  emit({ event: 'step_update', step_update: { step_type: 'user_input', text_delta: 'hidden user prompt' } });
  await new Promise(resolve => setTimeout(resolve, 1750));
  assert.equal(sent.length, 1);
  assert.equal(body(cards.get('card-1')), '正在检查中文😀。');
  assert.equal(cards.get('card-1').header.title.content, 'Antigravity · 执行中...');
  assert.equal(cards.get('card-1').header.template, 'blue');
  assert.match(detail(cards.get('card-1')), /run_command.*REDACTED/);
  assert.equal(detail(cards.get('card-1')).match(/run_command/g)?.length, 1, 'ACTIVE/DONE represent one tool call');
  assert.match(detail(cards.get('card-1')), /Read/);
  emit({ event: 'result', result: { response: '**最终答案**：完成。', usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 }, duration_seconds: 2.89 } }, false);
  await progress.dispose('must not duplicate final answer', true);
  const final = cards.get('card-1');
  assert.equal(sent.length, 1, 'finalize edits same card');
  assert.deepEqual(final.header, {
    template: 'blue', title: { tag: 'plain_text', content: 'Antigravity · 执行完成' },
  });
  assert.equal(body(final), '**最终答案**：完成。');
  assert.match(detail(final), /正在检查中文😀/);
  assert.match(note(final), /本轮耗时.*输入 120 tokens.*输出 30 tokens.*总计 150 tokens.*2.89秒/);
  assert.doesNotMatch(JSON.stringify(final), /hidden|secret tool payload|sk-secret123|step_update|text_delta|must not duplicate/);
  assert.ok(sent.every(message => message.threadRootMessageId === 'root'));

  const long = await attachLiveRoomProgress(args);
  long.streamCallbacks.onStdoutChunk!(JSON.stringify({ event: 'step_update', step_update: { tool_name: 'long_output_tool' } }) + '\n');
  const longText = '中文😀"\\\t'.repeat(5000);
  long.streamCallbacks.onStdoutChunk!(JSON.stringify({ event: 'step_update', step_update: { text_delta: longText } }) + '\n');
  long.streamCallbacks.onStdoutChunk!(JSON.stringify({ event: 'result', result: { response: longText } }));
  await long.dispose('', true);
  assert.equal(sent.length, 2, 'long reply still creates only one card');
  assert.match(body(cards.get('card-2')), /预览已截断/);
  assert.match(detail(cards.get('card-2')), /long_output_tool/, 'long text does not erase tool history');
  assert.doesNotMatch(body(cards.get('card-2')), /[\uD800-\uDBFF]\n/);
  assert.match(note(cards.get('card-2')), /Token 用量未提供/);

  const failed = await attachLiveRoomProgress(args);
  failed.streamCallbacks.onStdoutChunk!(chunk);
  await new Promise(resolve => setTimeout(resolve, 1150));
  const count = sent.length;
  failUpdates = true;
  await assert.rejects(failed.dispose('execution error', false), /update failed/);
  assert.equal(sent.length, count, 'failed edit never sends duplicate card');
  failUpdates = false;

  const empty = await attachLiveRoomProgress(args);
  await empty.dispose('permission denied', false);
  assert.equal(body(Array.from(cards.values()).at(-1)), 'permission denied');
  assert.deepEqual(Array.from(cards.values()).at(-1).header, {
    template: 'blue', title: { tag: 'plain_text', content: 'Antigravity · 执行失败' },
  });

  const restarted = await attachLiveRoomProgress(args);
  restarted.streamCallbacks.onStdoutChunk!(chunk + JSON.stringify({ event: 'init' }) + '\n');
  restarted.streamCallbacks.onStdoutChunk!(JSON.stringify({ event: 'step_update', step_update: { text_delta: '新的指令回答' } }));
  await restarted.dispose('done', true);
  assert.equal(body(Array.from(cards.values()).at(-1)), '新的指令回答', 'steering resets reply but retains process details');

  (prisma as any).$queryRaw = async () => [];
  const unbound = await attachLiveRoomProgress({ ...args, sourceMessage: {} });
  assert.equal(unbound.progressTracker, null);
  const before = sent.length;
  unbound.streamCallbacks.onStdoutChunk!(chunk);
  await unbound.dispose('', true);
  assert.equal(sent.length, before);

  const originalInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalNow = Date.now;
  let heartbeat: (() => void) | undefined;
  let stopped = false;
  const timer = { unref() {} } as ReturnType<typeof setInterval>;
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    assert.equal(delay, 45000);
    heartbeat = callback;
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: any) => {
    if (handle === timer) stopped = true;
    else originalClearInterval(handle);
  }) as typeof clearInterval;
  try {
    const idle = await attachLiveRoomProgress(args);
    const idleCard = `card-${sent.length}`;
    const count = sent.length;
    const start = originalNow();
    Date.now = () => start + 45000;
    heartbeat!();
    assert.equal(roomProgress.length, 0, 'no room heartbeat before 90 seconds');
    Date.now = () => start + 90000;
    heartbeat!();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(roomProgress.length, 1, 'long Antigravity work is visible in the room');
    assert.match(roomProgress[0].content, /仍在处理中/);
    await idle.progressTracker!.flush();
    assert.equal(sent.length, count, 'silent heartbeat edits the original card');
    assert.match(body(cards.get(idleCard)), /Antigravity 正在处理信息/);
    assert.match(note(cards.get(idleCard)), /1分30秒/);
    await idle.dispose('done', true);
    assert.ok(stopped, 'completion stops heartbeat');
  } finally {
    Date.now = originalNow;
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClearInterval;
  }

  let missingIdSends = 0;
  Object.assign(api, { sendFeishuInteractiveMessage: async () => { missingIdSends++; return undefined; } });
  const missingId = await attachLiveRoomProgress(args);
  missingId.streamCallbacks.onStdoutChunk!(chunk);
  await assert.rejects(missingId.dispose('', true), /no message id/);
  assert.equal(missingIdSends, 1, 'missing message id must not create more cards');
  console.log('Structured reply cards: deltas, tools, usage, one-card limit, routing, redaction, restart and failure passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
