import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const localRequire = createRequire(__filename);
const liveRoomModule = localRequire.resolve('../src/lib/live-room');
const originalExports = localRequire(liveRoomModule) as typeof import('../src/lib/live-room');
localRequire.cache[liveRoomModule]!.exports = {
  ...originalExports,
  listLiveRoomCatalogAgents: async () => [
    { id: 'platform_local:platform-local:codex', gatewayId: 'platform-local', gatewayName: 'Platform Local', backend: 'platform_local', harnessType: 'codex', label: 'Codex', agentName: 'Codex', status: 'online' },
    { id: 'remote_ssh:ssh-1:claude', gatewayId: 'ssh-1', gatewayName: 'TX-server', backend: 'remote_ssh', harnessType: 'claude', label: 'Claude SSH', agentName: 'Claude', status: 'online' },
    { id: 'remote_ssh:remote-node:ww-16bd352b:pi-agent', gatewayId: 'remote-node:ww-16bd352b', gatewayName: 'ww-16bd352b', backend: 'remote_ssh', harnessType: 'pi-agent', label: 'Pi Runner', agentName: 'Pi Agent', status: 'online' },
  ],
};

async function main() {
  const { handleAgentsCommand } = await import('../src/lib/feishu-runtime-commands');
  const all = await handleAgentsCommand({ command: 'discover-agents', args: [], options: {} });
  assert.match(all, /platform_local:platform-local:codex/);
  assert.match(all, /remote_ssh:ssh-1:claude/);
  assert.match(all, /remote_ssh:remote-node:ww-16bd352b:pi-agent/);

  const runnerOnly = await handleAgentsCommand({ command: 'agents', args: ['remote-node:ww-16bd352b'], options: {} });
  assert.match(runnerOnly, /ww-16bd352b/);
  assert.doesNotMatch(runnerOnly, /ssh-1/);
}

main()
  .then(() => console.log('Feishu agent discovery command checks passed'))
  .finally(() => { localRequire.cache[liveRoomModule]!.exports = originalExports; })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
