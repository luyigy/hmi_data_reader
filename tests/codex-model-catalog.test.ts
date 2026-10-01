import assert from 'node:assert/strict';
import { validateCodexCatalogSelection, formatCodexModelCatalog } from '../src/lib/codex-model-catalog';

async function main() {
  const models = [{ id: 'test-model', efforts: ['low', 'high'], defaultEffort: 'low' }];
  validateCodexCatalogSelection(models, 'test-model', 'high');
  validateCodexCatalogSelection(models, 'test-model', null);
  validateCodexCatalogSelection(models, null, null);
  assert.throws(() => validateCodexCatalogSelection(models, 'typo', 'high'), /不在/);
  assert.throws(() => validateCodexCatalogSelection(models, 'test-model', 'ultra'), /不支持/);
  assert.throws(() => validateCodexCatalogSelection(models, null, 'high'), /同时指定/);
  assert.match(formatCodexModelCatalog(models), /test-model：low \/ high/);

  const bindings = require('../src/lib/feishu-live-room');
  const catalog = require('../src/lib/codex-model-catalog');
  const { prisma } = await import('../src/lib/prisma');
  const { handleCodexConfigCommand } = await import('../src/lib/feishu-live-room-commands');
  const original = { binding: bindings.getBoundLiveRoom, load: catalog.loadCodexModelCatalog, update: prisma.liveRoomMember.update };
  const member = { id: 'test', memberType: 'agent', canReply: true, displayName: 'codex', harnessType: 'codex', backend: 'platform_local', codexModel: null as string | null, codexReasoningEffort: null as string | null };
  let writes = 0;
  bindings.getBoundLiveRoom = async () => ({ members: [member], workingDirectory: '/test' });
  catalog.loadCodexModelCatalog = async (cwd: string) => { assert.equal(cwd, '/test'); return models; };
  prisma.liveRoomMember.update = (async ({ data }: { data: object }) => { writes++; return Object.assign(member, data); }) as unknown as typeof prisma.liveRoomMember.update;
  const command = (options: Record<string, string>, name: 'codex-config' | 'model-config' = 'codex-config') => handleCodexConfigCommand({ command: name, args: [], options: { agent: 'codex', ...options } });
  try {
    assert.match(await command({ list: 'true' }), /test-model/);
    assert.match(await command({ list: 'true', model: 'test-model' }), /分开发送/);
    assert.match(await command({ model: 'typo' }), /配置未修改/);
    assert.match(await command({ thinking: 'high' }), /同时指定/);
    assert.match(await command({ thinking: 'hgh' }), /格式无效/);
    assert.match(await command({ model: 'bad/model' }), /格式无效/);
    assert.equal(writes, 0);
    await command({ model: 'test-model', thinking: 'HIGH' });
    assert.equal(member.codexReasoningEffort, 'high');
    assert.equal(writes, 1);
    assert.match(await command({ thinking: 'ultra' }, 'model-config'), /不支持/);
    assert.match(await command({ model: 'typo' }), /不在/);
    assert.equal(writes, 1);
    await command({ thinking: 'low' });
    assert.equal(member.codexReasoningEffort, 'low');
    catalog.loadCodexModelCatalog = async () => { throw new Error('目录不可用'); };
    assert.match(await command({ thinking: 'high' }), /配置未修改/);
    assert.equal(writes, 2);
    await command({ model: 'inherit', thinking: 'inherit' });
    assert.equal(member.codexModel, null);
    assert.equal(member.codexReasoningEffort, null);
    member.backend = 'remote';
    assert.match(await command({ list: 'true' }), /仅支持 Platform Local/);
    assert.match(await command({ model: 'test-model' }), /配置未修改/);
    assert.equal(writes, 3);
  } finally {
    bindings.getBoundLiveRoom = original.binding;
    catalog.loadCodexModelCatalog = original.load;
    prisma.liveRoomMember.update = original.update;
  }
  console.log('Codex catalog and command validation passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
