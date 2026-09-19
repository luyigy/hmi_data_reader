// Optional native integration: PI_RPC_NATIVE_BIN=/path/to/pi <test command>.
// Uses the real Pi process with a loopback model stub; no external model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HarnessSteer } from '../src/lib/acpx/types';
import { runPiRpc } from '../src/lib/real-agents/pi-rpc';

async function main() {
  const binary = process.env.PI_RPC_NATIVE_BIN;
  if (!binary) { console.log('Skip native Pi smoke: set PI_RPC_NATIVE_BIN'); return; }
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-native-'));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(dir,'config');
  let steer!: HarnessSteer;
  let requests = 0, spawned = 0, tools = 0;
  let receipts: Promise<string>[] = [];
  const histories: string[] = [];
  const server = createServer((req,res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      histories.push(body); requests++;
      if (requests === 1) receipts = [steer('first','追加 FIRST'), steer('second','追加 SECOND'), steer('first','追加 FIRST')];
      res.writeHead(200, {'Content-Type':'text/event-stream'});
      const send = (delta: object, finish_reason: string | null) => res.write(`data: ${JSON.stringify({
        id:'smoke',object:'chat.completion.chunk',created:1,model:'smoke',choices:[{index:0,delta,finish_reason}],
      })}\n\n`);
      if (requests === 1) {
        send({role:'assistant',tool_calls:[{index:0,id:'tool1',type:'function',function:{name:'bash',arguments:JSON.stringify({command:'sleep 0.2'})}}]}, null);
        send({},'tool_calls');
      } else { send({role:'assistant',content:'native-ok'},null); send({},'stop'); }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    await mkdir(process.env.PI_CODING_AGENT_DIR!,{recursive:true});
    const address = server.address() as {port:number};
    await writeFile(path.join(process.env.PI_CODING_AGENT_DIR!,'models.json'),JSON.stringify({providers:{'ap-smoke':{
      baseUrl:`http://127.0.0.1:${address.port}/v1`,api:'openai-completions',apiKey:'test',models:[{id:'smoke'}],
    }}}));
    const args = ['--mode','rpc','--provider','ap-smoke','--model','smoke','--no-extensions','--no-skills',
      '--no-prompt-templates','--no-themes','--session-dir',path.join(dir,'sessions')];
    const options = {binary,args,prompt:'original',timeout:20_000,workingDirectory:dir,
      onSpawn:() => { spawned++; },onEvent:(line:string) => { if(JSON.parse(line).type === 'tool_execution_start') tools++; },
      streamCallbacks:{onSteeringReady:(control:HarnessSteer) => { steer=control; return () => {}; }}};
    assert.equal(await runPiRpc(options),'native-ok');
    assert.deepEqual(await Promise.all(receipts),['accepted','accepted','accepted']);
    assert.equal(spawned,1);
    assert.equal(tools,1);
    const last = JSON.parse(histories.at(-1)!);
    const userText = last.messages.filter((message:{role:string}) => message.role === 'user').map((message:{content:unknown}) => JSON.stringify(message.content)).join('\n');
    assert.equal(userText.split('FIRST').length-1,1);
    assert.equal(userText.split('SECOND').length-1,1);
    assert.equal(await runPiRpc({...options,args:[...args,'--continue'],prompt:'continuation'}),'native-ok');
    assert.match(histories.at(-1)!, /FIRST/);
    assert.match(histories.at(-1)!, /continuation/);
    let raced = false;
    let raceReceipt!: Promise<string>;
    const raceOutput = await runPiRpc({...options,args:[...args,'--continue'],prompt:'finish-boundary',onEvent:(line) => {
      if (JSON.parse(line).type === 'agent_end' && !raced) {
        raced = true;
        raceReceipt = steer('race','BOUNDARY');
      }
    }});
    assert.equal(raceOutput,'native-ok');
    assert.equal(await raceReceipt,'accepted');
    assert.match(histories.at(-1)!, /BOUNDARY/);
    assert.equal(spawned,3, 'completion race stays in the third process');
    console.log(`Native Pi passed: two steering messages once each, one process, real bash boundary, saved-session continuation and completion race (${requests} model calls)`);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if(oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=oldAgentDir;
    await rm(dir,{recursive:true,force:true});
  }
}
void main().catch(error => { console.error(error); process.exitCode=1; });
