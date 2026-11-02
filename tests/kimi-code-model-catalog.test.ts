import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'kimi-catalog-'));
  const binary = path.join(dir, 'kimi');
  const originalBinary = process.env.KIMI_CODE_CLI_PATH;
  await writeFile(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"providers":{"secret":"do-not-show"},"models":{"kimi-code/k3":{"displayName":"K3","supportEfforts":["low","high","max"],"defaultEffort":"high"},"kimi-code/k2":{"capabilities":["always_thinking"]}}}\'\n', { mode: 0o755 });
  process.env.KIMI_CODE_CLI_PATH = binary;
  const bindings = await import('../src/lib/feishu-live-room');
  const originalBinding = bindings.getBoundLiveRoom;
  const { prisma } = await import('../src/lib/prisma');
  const originalUpdate = prisma.liveRoomMember.update;
  const member = { id: 'kimi-test', memberType: 'agent', canReply: true, displayName: 'kimi-code', harnessType: 'kimi-code', backend: 'platform_local', codexModel: null as string | null, codexReasoningEffort: null as string | null };
  Object.assign(bindings, { getBoundLiveRoom: async () => ({ workingDirectory: dir, members: [member] }) });
  prisma.liveRoomMember.update = (async ({ data }: { data: object }) => Object.assign(member, data)) as unknown as typeof prisma.liveRoomMember.update;
  try {
    const { handleCodexConfigCommand } = await import('../src/lib/feishu-live-room-commands');
    const command = (options: Record<string, string>) => handleCodexConfigCommand({ command: 'model-config', args: [], options: { agent: 'kimi-code', ...options } });
    const list = await command({ list: 'true' });
    assert.match(list, /kimi-code\/k3.*low \/ high \/ max；默认 high/);
    assert.match(list, /kimi-code\/k2.*始终思考/);
    assert.doesNotMatch(list, /do-not-show/);
    assert.match(list, /不支持 --thinking/);
    assert.match(await command({ list: 'true', model: 'kimi-code/k3' }), /分开发送/);
    const { parseFeishuCommand } = await import('../src/lib/feishu-command-parser');
    const parsed = parseFeishuCommand({ text: '/ap model-config --agent=kimi-code --model=kimi-code/kimi-for-coding (K2.8 Preview)' } as Parameters<typeof parseFeishuCommand>[0]);
    assert.ok(parsed);
    assert.match(await handleCodexConfigCommand(parsed), /已更新/);
    assert.equal(member.codexModel, 'kimi-code/kimi-for-coding');
    assert.match(await command({}), /kimi-code\/kimi-for-coding/);
    await assert.rejects(command({ thinking: 'high' }), /思考/);
    assert.equal(member.codexReasoningEffort, null);
    for (const model of ['a b', 'a//b', '/model', 'provider/', '--bad', 'x'.repeat(201)]) {
      await assert.rejects(command({ model }), /Kimi/);
      assert.equal(member.codexModel, 'kimi-code/kimi-for-coding');
    }
    await command({ model: 'inherit' });
    assert.equal(member.codexModel, null);
    member.backend = 'remote_ssh';
    assert.match(await command({ list: 'true' }), /暂不支持模型\/强度切换/);
  } finally {
    bindings.getBoundLiveRoom = originalBinding;
    prisma.liveRoomMember.update = originalUpdate;
    if (originalBinary === undefined) delete process.env.KIMI_CODE_CLI_PATH; else process.env.KIMI_CODE_CLI_PATH = originalBinary;
    await rm(dir, { recursive: true, force: true });
  }
  console.log('Kimi model catalog command passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
