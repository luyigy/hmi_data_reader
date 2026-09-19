import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';

const originalFindUnique = prisma.feishuUserAccess.findUnique;
let agents = [{
  id: 'local:codex', label: 'Codex', status: 'online', gatewayId: 'local',
  gatewayName: 'local', backend: 'platform_local', harnessType: 'codex',
}];
let refreshFails = false;
let refreshGate: Promise<void> | undefined;

const localRequire = createRequire(__filename);
const liveRoomModule = localRequire.resolve('../src/lib/live-room');
const originalExports = localRequire(liveRoomModule) as typeof import('../src/lib/live-room');
localRequire.cache[liveRoomModule]!.exports = {
  ...originalExports,
  listLiveRoomCatalogAgents: async () => {
    if (refreshGate) await refreshGate;
    if (refreshFails) throw new Error('catalog unavailable');
    return agents;
  },
};
prisma.feishuUserAccess.findUnique = (async () => null) as typeof prisma.feishuUserAccess.findUnique;

async function main() {
  const { openFeishuRoomCreationCard, primeFeishuRoomCreationAgents } = await import('../src/lib/feishu-room-create-card');
  const args = { openId: 'user', chatId: 'chat', chatType: 'p2p' as const };
  async function checkSlowRefresh(expected: RegExp) {
    let release!: () => void;
    refreshGate = new Promise<void>((resolve) => { release = resolve; });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        openFeishuRoomCreationCard({ ...args, chatType: 'group' }),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Room card waited for slow discovery')), 2000);
        }),
      ]);
      assert.match(JSON.stringify(result), expected);
    } finally {
      clearTimeout(deadline);
      release();
      await primeFeishuRoomCreationAgents();
      refreshGate = undefined;
    }
  }
  await checkSlowRefresh(/Agent 列表正在加载/);
  const first = JSON.stringify(await openFeishuRoomCreationCard(args));
  assert.match(first, /local:codex/);

  agents = [{
    id: 'remote-node:runner:pi-agent', label: 'Pi Agent', status: 'online', gatewayId: 'runner',
    gatewayName: 'runner', backend: 'remote_ssh', harnessType: 'pi-agent',
  }];
  const refreshed = JSON.stringify(await openFeishuRoomCreationCard(args));
  assert.match(refreshed, /remote-node:runner:pi-agent/);
  assert.doesNotMatch(refreshed, /local:codex/);
  await checkSlowRefresh(/remote-node:runner:pi-agent/);

  refreshFails = true;
  const fallback = JSON.stringify(await openFeishuRoomCreationCard(args));
  assert.match(fallback, /remote-node:runner:pi-agent/);
}

main()
  .then(() => console.log('Feishu room creation card refresh checks passed'))
  .finally(() => {
    localRequire.cache[liveRoomModule]!.exports = originalExports;
    prisma.feishuUserAccess.findUnique = originalFindUnique;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
