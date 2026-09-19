import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPiRpc } from '../src/lib/real-agents/pi-rpc';
import type { HarnessSteer } from '../src/lib/acpx/types';

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-rpc-'));
  const fixture = path.join(dir, 'pi.cjs');
  await writeFile(fixture, `
const fs = require('node:fs');
const [scenario, log] = process.argv.slice(2);
let active = false, buffer = '', messages = [], timer;
const emit = (event) => process.stdout.write(JSON.stringify(event)+'\\n');
const reply = (c, success = true, data) => emit({type:'response', id:c.id, command:c.type, success, data, error:success ? undefined : 'rejected'});
function end(text, error) {
  active = false;
  emit({type:'message_end', message:{role:'assistant', content:[{type:'text',text}], stopReason:error ? 'error' : 'stop', errorMessage:error}});
  emit({type:'agent_end',messages:[]});
}
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split('\\n'); buffer = lines.pop();
  for (const line of lines) {
    const c = JSON.parse(line); fs.appendFileSync(log, line+'\\n');
    if (c.type === 'get_state') { reply(c,true,{isStreaming:active,isCompacting:false,pendingMessageCount:0}); continue; }
    if (c.streamingBehavior && scenario === 'disconnect') { process.exit(0); }
    if (c.streamingBehavior && scenario === 'unknown') { continue; }
    if (scenario === 'reject' || (c.streamingBehavior && scenario === 'steer-reject')) { reply(c,false); continue; }
    assertPrompt(c);
    messages.push(c.message); reply(c);
    if (!active) { active = true; emit({type:'agent_start'}); }
    clearTimeout(timer);
    if (scenario === 'timeout') continue;
    timer = setTimeout(() => {
      if (scenario === 'retry' && messages.length === 1) {
        end('partial','429 rate limit'); emit({type:'auto_retry_start'});
        setTimeout(() => { active=true; emit({type:'agent_start'}); emit({type:'auto_retry_end',success:true}); end('recovered'); },60);
      } else if (scenario === 'exhausted') {
        end('partial','429 rate limit'); emit({type:'auto_retry_end',success:false,finalError:'retries exhausted'});
      } else end(scenario === 'empty' ? '' : messages.join('|')+' 中文', scenario === 'error' ? 'model failed' : undefined);
    }, 80);
  }
});
function assertPrompt(c) { if(c.type !== 'prompt') throw Error('unexpected command'); }
`);
  try {
    let counter = 0;
    const run = async (scenario: string, onReady?: (steer: HarnessSteer) => void, timeout = 8_000) => {
      const log = path.join(dir, `${counter++}.jsonl`);
      let disposed = 0;
      const outcome = await runPiRpc({
        binary: process.execPath, args: [fixture, scenario, log], prompt: 'initial', timeout,
        workingDirectory: dir, onEvent: () => {},
        streamCallbacks: { onSteeringReady: steer => { onReady?.(steer); return () => { disposed++; }; } },
      }).then(output => ({ output, error: '' }), error => ({ output: '', error: error.message as string }));
      return { ...outcome, disposed, commands: (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
    };
    let first!: Promise<string>, duplicate!: Promise<string>, second!: Promise<string>, control!: HarnessSteer;
    const normal = await run('normal', steer => {
      control = steer;
      first = steer('m1','first'); duplicate = steer('m1','first'); second = steer('m2','second');
    });
    assert.equal(normal.output, 'initial|first|second 中文');
    assert.equal(normal.disposed, 1);
    assert.equal(first, duplicate, 'duplicate message shares receipt');
    assert.deepEqual(await Promise.all([first,second]), ['accepted','accepted']);
    assert.equal(normal.commands.filter(c => c.streamingBehavior === 'steer').length, 2);
    assert.equal(await control('late','late'), 'rejected');
    assert.equal((await run('retry')).output, 'recovered');
    assert.match((await run('error')).error, /model failed/);
    assert.match((await run('exhausted')).error, /retries exhausted/);
    assert.match((await run('empty')).error, /empty response/);
    assert.match((await run('timeout', undefined, 300)).error, /timed out/);
    assert.match((await run('reject')).error, /rejected/);
    let receipt!: Promise<string>;
    const disconnected = await run('disconnect', steer => { receipt = steer('disconnect','disconnect'); });
    assert.equal(await receipt, 'unknown');
    assert.match(disconnected.error, /exited before completion/);
    const unknown = await run('unknown', steer => { receipt = steer('lost','lost'); });
    assert.equal(await receipt, 'unknown');
    assert.equal(unknown.commands.filter(c => c.message === 'lost').length, 1);
    const rejected = await run('steer-reject', steer => { receipt = steer('bad','bad'); });
    assert.equal(await receipt, 'rejected');
    assert.equal(rejected.output, 'initial 中文');
    console.log('Pi RPC: steering, duplicate IDs, shutdown, retry, errors, empty output, timeout and lost receipt passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
