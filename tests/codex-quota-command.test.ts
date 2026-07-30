import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { clearKimiCodeQuotaCacheForTests } from '../src/lib/real-agents/kimi-code-telemetry';
import { handleStatusCommand } from '../src/lib/feishu-runtime-commands';

void (async () => {
  const originalAdmin = process.env.FEISHU_ADMIN_OPEN_ID;
  const originalHome = process.env.KIMI_CODE_HOME;
  const originalRaw = prisma.$queryRaw;
  const originalFindUnique = prisma.liveRoom.findUnique;
  const originalFetch = globalThis.fetch;
  process.env.FEISHU_ADMIN_OPEN_ID = 'admin';
  const denied = await handleStatusCommand(
    { command: 'status', args: [], options: { quota: 'true' } },
    {
      chatId: 'chat',
      chatType: 'p2p',
      senderOpenId: 'ordinary-user',
      messageId: 'message',
    },
  );
  assert.equal(denied, '仅配置的 Feishu 管理员可以查看 provider quota。');

  const home = await mkdtemp(path.join(tmpdir(), 'kimi-quota-command-'));
  await mkdir(path.join(home, 'credentials'));
  await writeFile(path.join(home, 'config.toml'), `
default_model = "kimi-code/k3"
[providers."managed:kimi-code"]
base_url = "https://api.kimi.com/coding/v1"
[models."kimi-code/k3"]
provider = "managed:kimi-code"
`);
  await writeFile(path.join(home, 'credentials', 'kimi-code.json'), JSON.stringify({
    access_token: 'command-token',
    expires_at: Date.now() / 1000 + 600,
  }));
  process.env.KIMI_CODE_HOME = home;
  prisma.$queryRaw = (async () => [{ liveRoomId: 'room-1' }]) as typeof prisma.$queryRaw;
  let harnessType = 'kimi-code';
  prisma.liveRoom.findUnique = (async () => ({
    id: 'room-1',
    currentSpeakerMemberId: 'member-1',
    sourceTask: null,
    members: [{
      id: 'member-1',
      memberType: 'local_agent',
      canReply: true,
      displayName: 'Kimi',
      userNickname: null,
      shortAlias: null,
      backend: 'platform_local',
      harnessType,
    }],
  })) as unknown as typeof prisma.liveRoom.findUnique;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({
      usage: { used: 12, limit: 100, resetTime: '2026-08-03T00:00:00.000Z' },
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const context: NonNullable<Parameters<typeof handleStatusCommand>[1]> = {
      chatId: 'chat',
      chatType: 'p2p',
      senderOpenId: 'admin',
      messageId: 'message',
    };
    const command: NonNullable<Parameters<typeof handleStatusCommand>[0]> = {
      command: 'status',
      args: [],
      options: { quota: 'true' },
    };
    const kimi = await handleStatusCommand(command, context);
    assert.match(kimi, /Kimi Code quota[\s\S]*status: available[\s\S]*weekly: used 12\/100/);
    harnessType = 'antigravity';
    const antigravity = await handleStatusCommand(command, context);
    assert.match(antigravity, /Antigravity quota[\s\S]*status: unknown/);
    assert.equal(fetchCount, 1);
  } finally {
    clearKimiCodeQuotaCacheForTests();
    prisma.$queryRaw = originalRaw;
    prisma.liveRoom.findUnique = originalFindUnique;
    globalThis.fetch = originalFetch;
    if (originalAdmin === undefined) delete process.env.FEISHU_ADMIN_OPEN_ID;
    else process.env.FEISHU_ADMIN_OPEN_ID = originalAdmin;
    if (originalHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }

  console.log('provider quota command checks passed');
})();
