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
  const bindings = require('../src/lib/feishu-live-room');
  const originalBinding = bindings.getBoundLiveRoom;
  const member = { id: 'kimi-test', memberType: 'agent', canReply: true, displayName: 'kimi-code', harnessType: 'kimi-code', backend: 'platform_local', codexModel: null, codexReasoningEffort: null };
  bindings.getBoundLiveRoom = async () => ({ workingDirectory: dir, members: [member] });
  try {
    const { handleCodexConfigCommand } = await import('../src/lib/feishu-live-room-commands');
    const command = (options: Record<string, string>) => handleCodexConfigCommand({ command: 'model-config', args: [], options: { agent: 'kimi-code', ...options } });
    const list = await command({ list: 'true' });
    assert.match(list, /kimi-code\/k3.*low \/ high \/ max；默认 high/);
    assert.match(list, /kimi-code\/k2.*始终思考/);
    assert.doesNotMatch(list, /do-not-show/);
    assert.match(list, /不支持 --thinking/);
    assert.match(await command({ list: 'true', model: 'kimi-code/k3' }), /分开发送/);
    member.backend = 'remote_ssh';
    assert.match(await command({ list: 'true' }), /暂不支持模型\/强度切换/);
  } finally {
    bindings.getBoundLiveRoom = originalBinding;
    if (originalBinary === undefined) delete process.env.KIMI_CODE_CLI_PATH; else process.env.KIMI_CODE_CLI_PATH = originalBinary;
    await rm(dir, { recursive: true, force: true });
  }
  console.log('Kimi model catalog command passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
