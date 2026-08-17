import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFeishuCommand } from '../src/lib/feishu-command-parser';
import {
  buildFeishuCommandFromForm,
  buildFeishuRoomCreationCard,
  formatFeishuHelp,
} from '../src/lib/feishu-help';

const message = (text: string) => ({
  chatId: 'chat',
  chatType: 'p2p' as const,
  messageId: 'message',
  senderOpenId: 'user',
  messageType: 'text' as const,
  text,
  mentions: [],
  mentionNames: [],
});

// --- command parsing ---------------------------------------------------------

assert.deepEqual(parseFeishuCommand(message('/ap timeout 30')), {
  command: 'timeout',
  args: ['30'],
  options: {},
});
assert.deepEqual(parseFeishuCommand(message('/ap timeout inherit')), {
  command: 'timeout',
  args: ['inherit'],
  options: {},
});
assert.deepEqual(parseFeishuCommand(message('/ap timeout=45')), {
  command: 'timeout',
  args: ['45'],
  options: { timeout: '45' },
});
assert.deepEqual(
  parseFeishuCommand(message('/ap room --workdir=/repo --agents=local:codex --timeout=45'))!.options,
  { workdir: '/repo', agents: 'local:codex', timeout: '45' },
);

// --- help + room creation card ----------------------------------------------

const help = formatFeishuHelp({ args: [], options: {} });
if (typeof help !== 'string') throw new Error('expected plain help text');
assert.match(help, /\/ap timeout \[<1-1440 分钟>\|inherit\]/);
assert.match(help, /\[--timeout=<1-1440 分钟>\]/);

const card = JSON.stringify(
  buildFeishuRoomCreationCard('p2p', [{ id: 'local:codex', label: 'Codex · local' }], null),
);
assert.match(card, /"name":\s*"timeout"/);
assert.match(card, /执行超时（分钟，可选）/);

// --- form submission maps the timeout input to /ap room --timeout -------------

const withTimeout = buildFeishuCommandFromForm('form-room-create', {
  workdir: '/repo',
  agents: 'local:codex',
  profile: 'safe',
  mode: 'discussion',
  timeout: '30',
});
assert.equal(withTimeout?.command, 'room');
assert.equal(withTimeout?.options.timeout, '30');

const withoutTimeout = buildFeishuCommandFromForm('form-room-create', {
  workdir: '/repo',
  agents: 'local:codex',
  profile: 'safe',
  mode: 'discussion',
});
assert.equal(withoutTimeout?.options.timeout, undefined);

// --- both entry points share the same update function ------------------------

const commands = readFileSync('src/lib/feishu-live-room-commands.ts', 'utf8');
const callSites = commands.match(/applyLiveRoomExecutionTimeoutUpdate\(\{/g) ?? [];
assert.equal(
  callSites.length,
  2,
  'both /ap room --timeout and /ap timeout must reuse applyLiveRoomExecutionTimeoutUpdate',
);
assert.match(commands, /export async function handleTimeoutCommand/);
assert.match(commands, /执行超时：\$\{formatLiveRoomExecutionTimeoutMinutes/);
assert.match(
  commands,
  /systemEvent: 'execution_timeout_changed'/,
  'timeout changes must be recorded as room system events',
);

// --- handler behavior with a patched prisma client ----------------------------

async function runHandlerChecks() {
  const { prisma } = await import('../src/lib/prisma');
  const { handleTimeoutCommand } = await import('../src/lib/feishu-live-room-commands');

  const originalQueryRaw = prisma.$queryRaw;
  const originalFindUnique = prisma.liveRoom.findUnique;
  const originalUpdate = prisma.liveRoom.update;
  const originalCreate = prisma.liveRoomMessage.create;

  let executionTimeoutMs: number | null = null;
  const updates: Array<Record<string, unknown>> = [];
  const systemEvents: Array<string | null | undefined> = [];

  prisma.$queryRaw = (async (...args: unknown[]) => {
    const sql = String((args[0] as TemplateStringsArray | undefined)?.[0] ?? '');
    // Only the scope-key binding lookup resolves to the bound room; relay lookups see none.
    return sql.includes('FROM "FeishuConversationBinding"') && sql.includes('"scopeKey"')
      ? [{ liveRoomId: 'room-timeout-1' }]
      : [];
  }) as typeof prisma.$queryRaw;
  prisma.liveRoom.findUnique = (async () => ({
    id: 'room-timeout-1',
    title: 'Timeout Room',
    handoffLimit: 4,
    executionTimeoutMs,
    currentTopic: null,
    members: [],
    sourceTask: null,
  })) as unknown as typeof prisma.liveRoom.findUnique;
  prisma.liveRoom.update = (async ({ data }: { data: Record<string, unknown> }) => {
    updates.push(data);
    if (typeof data.executionTimeoutMs === 'number' || data.executionTimeoutMs === null) {
      executionTimeoutMs = data.executionTimeoutMs as number | null;
    }
    return { id: 'room-timeout-1', executionTimeoutMs };
  }) as unknown as typeof prisma.liveRoom.update;
  prisma.liveRoomMessage.create = (async ({ data }: { data: { metadata?: string | null } }) => {
    const metadata = data.metadata ? JSON.parse(data.metadata) as Record<string, unknown> : null;
    systemEvents.push(typeof metadata?.systemEvent === 'string' ? metadata.systemEvent : null);
    return {
      id: `sys-${systemEvents.length}`,
      roomId: 'room-timeout-1',
      senderMemberId: null,
      senderMember: null,
      createdAt: new Date(),
      visibility: 'room',
      ...data,
    };
  }) as unknown as typeof prisma.liveRoomMessage.create;

  const context = {
    chatId: 'chat-1',
    chatType: 'p2p' as const,
    senderOpenId: 'user-1',
    messageId: 'msg-1',
  };

  try {
    const current = await handleTimeoutCommand(parseFeishuCommand(message('/ap timeout'))!, context);
    assert.match(current, /当前执行超时：继承默认/);
    assert.match(current, /1-1440/);

    const set30 = await handleTimeoutCommand(parseFeishuCommand(message('/ap timeout 30'))!, context);
    assert.match(set30, /已设为 30 分钟/);
    assert.deepEqual(updates.at(-1), { executionTimeoutMs: 30 * 60 * 1000 });
    assert.equal(systemEvents.at(-1), 'execution_timeout_changed');

    const invalid = await handleTimeoutCommand(parseFeishuCommand(message('/ap timeout 0.5'))!, context);
    assert.match(invalid, /无效执行超时/);
    assert.equal(updates.length, 1);

    const invalidHigh = await handleTimeoutCommand(parseFeishuCommand(message('/ap timeout 1441'))!, context);
    assert.match(invalidHigh, /无效执行超时/);

    const inherit = await handleTimeoutCommand(parseFeishuCommand(message('/ap timeout inherit'))!, context);
    assert.match(inherit, /恢复默认/);
    assert.deepEqual(updates.at(-1), { executionTimeoutMs: null });
    assert.equal(systemEvents.at(-1), 'execution_timeout_changed');
  } finally {
    prisma.$queryRaw = originalQueryRaw;
    prisma.liveRoom.findUnique = originalFindUnique;
    prisma.liveRoom.update = originalUpdate;
    prisma.liveRoomMessage.create = originalCreate;
  }
}

runHandlerChecks()
  .then(() => console.log('Feishu room execution timeout command tests passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
