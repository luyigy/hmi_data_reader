import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePiRuntimeState } from '../src/lib/real-agents/pi-runtime-state';
import type { HarnessExecutionContext } from '../src/lib/harness/types';

async function main() {
  const at = new Date().toISOString();
  const entry = (type: string, id: string, parentId: string | null, extra: object = {}) =>
    JSON.stringify({ type, id, parentId, timestamp: at, ...extra });
  const lines = [JSON.stringify({ type: 'session', id: 'native', timestamp: at }),
    entry('model_change', 'm1', null, { provider: 'old', modelId: 'old' }),
    entry('thinking_level_change', 't1', 'm1', { thinkingLevel: 'high' }),
    entry('message', 'u1', 't1', { message: { role: 'user' } }),
    entry('message', 'a1', 'u1', { message: { role: 'assistant', provider: 'zai', model: 'glm-5.3', stopReason: 'stop' } }),
    entry('thinking_level_change', 't2', 'm1', { thinkingLevel: 'low' })];
  const scope = { executionId: 'execution', sessionDir: '/session', sessionId: 'native',
    startedAt: Date.parse(at) - 1, completedAt: Date.parse(at) + 1 };
  const state = parsePiRuntimeState(lines, scope);
  assert.equal(state?.model, 'glm-5.3');
  assert.equal(state?.provider, 'zai');
  assert.deepEqual(state?.reasoning, { kind: 'level', value: 'high' }, 'ignore abandoned sibling branch');
  assert.equal(state?.sessionId, '/session');
  assert.equal(parsePiRuntimeState(lines, { ...scope, sessionId: 'other' }), undefined);
  assert.equal(parsePiRuntimeState(lines, { ...scope, startedAt: Date.parse(at) + 1 }), undefined);
  const withoutThinking = [...lines.slice(0, 2),
    entry('message', 'u1', 'm1', { message: { role: 'user' } }),
    entry('message', 'a1', 'u1', { message: { role: 'assistant', provider: 'zai', model: 'glm-5.3' } })];
  assert.deepEqual(parsePiRuntimeState(withoutThinking, scope)?.reasoning, { kind: 'unknown' });

  const root = await mkdtemp(path.join(tmpdir(), 'pi-runtime-'));
  const binary = path.join(root, 'pi');
  const previous = { bin: process.env.PI_AGENT_BIN, sessions: process.env.PI_AGENT_SESSION_ROOT };
  process.env.PI_AGENT_BIN = binary;
  process.env.PI_AGENT_SESSION_ROOT = root;
  await writeFile(binary, `#!/usr/bin/env node
const fs=require('fs'), path=require('path'), args=process.argv.slice(2);
const dir=args[args.indexOf('--session-dir')+1], file=path.join(dir,'native.jsonl');
fs.mkdirSync(dir,{recursive:true});
const id='native', now=new Date().toISOString(), serial=String(Date.now())+Math.random().toString(16).slice(2);
if(!fs.existsSync(file)) fs.writeFileSync(file,JSON.stringify({type:'session',id,timestamp:now})+'\\n');
const existing=fs.readFileSync(file,'utf8').trim().split('\\n').map(JSON.parse), parent=existing.length===1?null:existing.at(-1).id;
let last=parent, index=0;
for(const [type,more] of [['model_change',{provider:'reported',modelId:'reported-model'}],['thinking_level_change',{thinkingLevel:'off'}],['message',{message:{role:'user'}}],['message',{message:{role:'assistant',provider:'reported',model:'reported-model',stopReason:'stop'}}]]) {
 const eid=serial+(index++), e={type,id:eid,parentId:last,timestamp:new Date().toISOString(),...more};fs.appendFileSync(file,JSON.stringify(e)+'\\n');last=eid;
}
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
if(args.includes('rpc')) {let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;const lines=buffer.split('\\n');buffer=lines.pop();for(const line of lines){const c=JSON.parse(line);emit({type:'response',id:c.id,success:true,data:{isStreaming:false,isCompacting:false,pendingMessageCount:0,sessionFile:file,sessionId:id}});if(c.type==='prompt'){emit({type:'agent_start'});emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'OK'}]}});emit({type:'agent_end'});}}});}
else if(process.env.PI_RUNTIME_PRINT==='1'&&args.includes('json')){process.stderr.write('unknown option --mode');process.exit(2);}
else if(args.includes('--print'))process.stdout.write('OK');
else {emit({type:'session',id,timestamp:now});emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'OK'}]}});}
`, { mode: 0o755 });
  try {
    const { piAgentHarnessAdapter: adapter } = await import('../src/lib/harness/adapters/pi-agent');
    const context: HarnessExecutionContext = { executionId: 'execution', workingDirectory: root,
      executionBackend: 'platform_local', timeout: 5000, sessionKey: 'runtime',
      model: 'requested/requested-model', reasoningEffort: 'high' };
    const task = { id: 'runtime', name: 'runtime' };
    const json = await adapter.execute({ task, context });
    assert.equal(json.success, true, json.error);
    assert.equal(json.runtimeState?.model, 'reported-model', JSON.stringify(json));
    assert.deepEqual(json.runtimeState?.reasoning, { kind: 'level', value: 'off' });
    const resumed = await adapter.resume!({ task, sessionId: json.sessionId!, continuationMessage: 'next', context });
    assert.equal(resumed.runtimeState?.model, 'reported-model');
    const rpc = await adapter.execute({ task, context: { ...context, streamCallbacks: { onSteeringReady: () => () => {} } } });
    assert.equal(rpc.runtimeState?.provider, 'reported');
    process.env.PI_RUNTIME_PRINT = '1';
    const print = await adapter.execute({ task, context });
    assert.equal(print.runtimeState?.model, 'reported-model');
  } finally {
    if (previous.bin === undefined) delete process.env.PI_AGENT_BIN; else process.env.PI_AGENT_BIN = previous.bin;
    if (previous.sessions === undefined) delete process.env.PI_AGENT_SESSION_ROOT; else process.env.PI_AGENT_SESSION_ROOT = previous.sessions;
    delete process.env.PI_RUNTIME_PRINT;
    await rm(root, { recursive: true, force: true });
  }
  console.log('Pi runtime state: branch, JSON, RPC, print and resume passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
