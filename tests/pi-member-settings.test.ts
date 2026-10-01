import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getMemberModelCapabilities, joinPiModel, normalizeMemberModelSettings, splitPiModel } from '../src/lib/live-room-codex-settings';
import type { HarnessExecutionContext } from '../src/lib/harness/types';

async function main() {
  const normalize = (model: unknown, reasoningEffort?: unknown) => normalizeMemberModelSettings({ model, reasoningEffort }, 'pi-agent', 'platform_local');
  assert.deepEqual(normalize(' custom-provider/vendor/model:1 ', 'OFF'), { model: 'custom-provider/vendor/model:1', reasoningEffort: 'off' });
  assert.deepEqual(splitPiModel('custom-provider/vendor/model:1'), { provider: 'custom-provider', model: 'vendor/model:1' });
  assert.equal(joinPiModel('custom-provider', 'vendor/model:1'), 'custom-provider/vendor/model:1');
  assert.deepEqual(normalize('', ''), { model: null, reasoningEffort: null });
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']) assert.equal(normalize(null, level).reasoningEffort, level);
  for (const level of ['none', 'max', 'ultra', 3]) assert.throws(() => normalize(null, level));
  for (const model of [3, {}, '--bad', 'a b', 'provider/', '/model', 'a//b', 'a\nb', 'x'.repeat(201)]) assert.throws(() => normalize(model));
  assert.throws(() => joinPiModel('provider', ''));
  assert.throws(() => joinPiModel('bad/provider', 'model'));
  assert.throws(() => joinPiModel('', 'vendor/model'));
  assert.equal(getMemberModelCapabilities('pi-agent', 'remote_ssh').model, false);
  assert.throws(() => normalizeMemberModelSettings({ reasoningEffort: 'off' }, 'codex', 'platform_local'));

  const dir = await mkdtemp(path.join(tmpdir(), 'pi-settings-'));
  const binary = path.join(dir, 'pi');
  const previousEnv = { ...process.env };
  Object.assign(process.env, {
    PI_AGENT_BIN: binary, PI_AGENT_SESSION_ROOT: dir,
    PI_AGENT_PROVIDER: 'env-provider', PI_AGENT_MODEL: 'env-model', PI_AGENT_THINKING: 'medium',
  });
  await writeFile(binary, `#!/usr/bin/env node
const args = process.argv.slice(2);
const emit = x => process.stdout.write(JSON.stringify(x)+'\\n');
const end = () => { emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}]}}); emit({type:'agent_end',messages:[]}); };
if (args.includes('rpc')) {
  let buffer = '';
  process.stdin.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\\n'); buffer = lines.pop();
    for (const line of lines) {
      const c = JSON.parse(line);
      emit({type:'response',id:c.id,command:c.type,success:true,data:{isStreaming:false,isCompacting:false,pendingMessageCount:0}});
      if (c.type === 'prompt') { emit({type:'agent_start'}); end(); }
    }
  });
} else if (process.env.PI_TEST_FALLBACK && args.includes('json')) {
  process.stderr.write('unknown option --mode'); process.exit(2);
} else if (args.includes('--print')) process.stdout.write('done');
else end();
`, { mode: 0o755 });
  try {
    const { piAgentHarnessAdapter: adapter } = await import('../src/lib/harness/adapters/pi-agent');
    const calls: string[][] = [];
    const context: HarnessExecutionContext = {
      workingDirectory: dir, executionBackend: 'platform_local', timeout: 5000,
      sessionKey: 'settings', model: 'custom-provider/vendor/model:1', reasoningEffort: 'off',
      onSpawn: child => { calls.push(child.spawnargs); },
    };
    const task = { id: 'settings', name: 'settings' };
    const expectFlags = (args: string[], provider: string, model: string, thinking: string) => {
      for (const [flag, value] of [['--provider', provider], ['--model', model], ['--thinking', thinking]]) {
        assert.equal(args[args.indexOf(flag) + 1], value, flag);
        assert.equal(args.filter(arg => arg === flag).length, 1);
      }
    };
    const first = await adapter.execute({ task, context });
    assert.equal(first.success, true, first.error);
    expectFlags(calls.at(-1)!, 'custom-provider', 'vendor/model:1', 'off');
    const resumed = await adapter.resume!({ task, sessionId: first.sessionId!, continuationMessage: 'next', context: { ...context, model: 'other/new', reasoningEffort: 'xhigh' } });
    assert.equal(resumed.success, true, resumed.error);
    assert.ok(calls.at(-1)!.includes('--continue'));
    expectFlags(calls.at(-1)!, 'other', 'new', 'xhigh');
    for (const resume of [false, true]) {
      const rpcContext = { ...context, streamCallbacks: { onSteeringReady: () => () => {} } };
      const rpc = resume
        ? await adapter.resume!({ task, sessionId: first.sessionId!, continuationMessage: 'rpc', context: rpcContext })
        : await adapter.execute({ task, context: rpcContext });
      assert.equal(rpc.success, true, rpc.error);
      assert.ok(calls.at(-1)!.includes('rpc'));
      expectFlags(calls.at(-1)!, 'custom-provider', 'vendor/model:1', 'off');
    }
    process.env.PI_TEST_FALLBACK = '1';
    assert.equal((await adapter.execute({ task, context })).success, true);
    assert.ok(calls.at(-1)!.includes('--print'));
    expectFlags(calls.at(-1)!, 'custom-provider', 'vendor/model:1', 'off');
    delete process.env.PI_TEST_FALLBACK;
    assert.equal((await adapter.execute({ task, context: { ...context, model: undefined, reasoningEffort: undefined } })).success, true);
    expectFlags(calls.at(-1)!, 'env-provider', 'env-model', 'medium');
    assert.equal((await adapter.execute({ task, context: { ...context, model: 'bare-model' } })).success, true);
    expectFlags(calls.at(-1)!, 'env-provider', 'bare-model', 'off');
    const count = calls.length;
    assert.equal((await adapter.execute({ task, context: { ...context, model: '--invalid' } })).success, false);
    assert.equal(calls.length, count, 'invalid input must not spawn');
    console.log('Pi member settings: validation, provider override, JSON/RPC/print, new/resumed sessions and environment defaults passed');
  } finally {
    for (const key of ['PI_AGENT_BIN', 'PI_AGENT_SESSION_ROOT', 'PI_AGENT_PROVIDER', 'PI_AGENT_MODEL', 'PI_AGENT_THINKING', 'PI_TEST_FALLBACK']) {
      if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key];
    }
    await rm(dir, { recursive: true, force: true });
  }
  // Exercise the Feishu handler with in-memory persistence; no messages or DB writes.
  const bindings = require('../src/lib/feishu-live-room');
  const { prisma } = await import('../src/lib/prisma');
  const { handleCodexConfigCommand } = await import('../src/lib/feishu-live-room-commands');
  const originalBinding = bindings.getBoundLiveRoom;
  const originalUpdate = prisma.liveRoomMember.update;
  const member = { id: 'pi-test', memberType: 'agent', canReply: true, displayName: 'pi-agent', harnessType: 'pi-agent', backend: 'platform_local', codexModel: null as string | null, codexReasoningEffort: null as string | null };
  bindings.getBoundLiveRoom = async () => ({ members: [member] });
  prisma.liveRoomMember.update = (async ({ data }: { data: object }) => Object.assign(member, data)) as unknown as typeof prisma.liveRoomMember.update;
  const command = (options: Record<string, string>) => handleCodexConfigCommand({ command: 'model-config', args: [], options: { agent: 'pi-agent', ...options } });
  try {
    assert.match(await command({ provider: 'custom', model: 'vendor/model', thinking: 'off' }), /custom\/vendor\/model/);
    assert.equal(member.codexReasoningEffort, 'off');
    assert.match(await command({}), /custom\/vendor\/model/);
    await command({ provider: 'second', thinking: 'high' });
    assert.equal(member.codexModel, 'second/vendor/model');
    await command({ model: 'third/model', thinking: 'minimal' });
    assert.equal(member.codexModel, 'third/model');
    await assert.rejects(command({ thinking: 'ultra' }));
    assert.equal(member.codexReasoningEffort, 'minimal');
    await command({ model: 'inherit', thinking: 'inherit' });
    assert.equal(member.codexModel, null);
    assert.equal(member.codexReasoningEffort, null);
    await assert.rejects(command({ provider: 'missing-model' }));
    member.harnessType = 'codex';
    assert.match(await command({ provider: 'custom' }), /仅支持 Pi/);
  } finally {
    bindings.getBoundLiveRoom = originalBinding;
    prisma.liveRoomMember.update = originalUpdate;
  }

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
