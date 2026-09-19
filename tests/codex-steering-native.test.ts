// Real Codex + loopback Responses API fixture, never an external model request.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HarnessSteer } from '../src/lib/acpx/types';
import { runCodexAppServer } from '../src/lib/real-agents/codex-app-server';

async function main() {
  if (!process.env.CODEX_STEERING_NATIVE) { console.log('Skip native Codex: set CODEX_STEERING_NATIVE=1'); return; }
  const dir=await mkdtemp(path.join(tmpdir(),'codex-steering-native-'));
  const histories: Array<{input: Array<{role?:string; content?:unknown}>; tools: Array<{name:string}>}> = [];
  const events: Array<{method?:string;params?:{threadId?:string;turn?:{id:string};item?:{type:string;content?:unknown}}}> = [];
  let steer!: HarnessSteer;
  let receipts: Promise<string>[]=[];
  let spawned=0, toolCalls=0;
  const server=createServer((req,res)=>{
    let body=''; req.on('data',chunk=>{body+=chunk;});
    req.on('end',()=>{
      const request=JSON.parse(body); histories.push(request);
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      const emit=(type:string,data:object)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
      const id=`response-${histories.length}`;
      emit('response.created',{response:{id,object:'response',status:'in_progress',output:[]}});
      let item;
      if(histories.length===1) {
        const names=request.tools.map((t:{name:string})=>t.name);
        const name=names.includes('exec_command')?'exec_command':names.includes('shell_command')?'shell_command':'shell';
        assert.ok(names.includes(name),`Missing shell tool: ${names}`);
        const args=name==='exec_command'?{cmd:'sleep 0.3',yield_time_ms:1000}:name==='shell_command'?{command:'sleep 0.3'}:{command:['bash','-c','sleep 0.3']};
        item={id:'fc-1',type:'function_call',call_id:'call-1',name,arguments:JSON.stringify(args),status:'completed'};
      } else {
        item={id:'msg-1',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'hello native',annotations:[]}]};
      }
      emit('response.output_item.added',{output_index:0,item});
      if(item.type==='message') emit('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:'hello native'});
      emit('response.output_item.done',{output_index:0,item});
      emit('response.completed',{response:{id,object:'response',status:'completed',output:[item],usage:{input_tokens:100,output_tokens:20,total_tokens:120}}});
      res.end();
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const port=(server.address() as {port:number}).port;
    await writeFile(path.join(dir,'config.toml'),`model = "gpt-test"
model_provider = "fixture"
[features]
code_mode = false
[model_providers.fixture]
name = "Loopback fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
`);
    const result=await runCodexAppServer({prompt:'Run a shell command, then finish.',workingDirectory:dir,
      sandboxMode:'danger-full-access',approvalPolicy:'never',timeout:20_000,
      env:{...process.env,CODEX_HOME:dir},
      onSpawn:child=>{
        spawned++; let buffer='';
        child.stdout!.on('data',chunk=>{
          buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop()!;
          for(const line of lines) if(line.trim()) events.push(JSON.parse(line));
        });
      },
      streamCallbacks:{
        onSteeringReady:control=>{steer=control;return ()=>{};},
        onToolEvent:event=>{
          if(event.toolName==='Bash' && !toolCalls++) receipts=[steer('first','输出 hello FIRST'),steer('second','SECOND'),steer('first','输出 hello FIRST')];
        },
      },
    });
    assert.deepEqual(await Promise.all(receipts),['accepted','accepted','accepted']);
    assert.equal(spawned,1); assert.equal(toolCalls,1);
    assert.equal(histories.length,2);
    const userText=(index:number)=>JSON.stringify(histories[index].input.filter(item=>item.role==='user'));
    assert.doesNotMatch(userText(0),/FIRST|SECOND/);
    assert.equal(userText(1).split('FIRST').length-1,1);
    assert.equal(userText(1).split('SECOND').length-1,1);
    assert.ok(userText(1).indexOf('FIRST')<userText(1).indexOf('SECOND'));
    const starts=events.filter(e=>e.method==='turn/started');
    const ends=events.filter(e=>e.method==='turn/completed');
    assert.equal(starts.length,1);assert.equal(ends.length,1);
    assert.equal(starts[0].params!.turn!.id,ends[0].params!.turn!.id);
    assert.equal(starts[0].params!.threadId,result.threadId);
    assert.equal(await steer('late','late'),'rejected');
    console.log(JSON.stringify({version:execFileSync('codex',['--version'],{encoding:'utf8'}).trim(),
      threadId:result.threadId,turnId:starts[0].params!.turn!.id,processes:spawned,turnStarts:starts.length,
      modelRequests:histories.length,acceptedUniqueMessages:2,firstRequestContainsSteering:false,
      secondRequestContainsEachOnce:true,output:result.output},null,2));
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
