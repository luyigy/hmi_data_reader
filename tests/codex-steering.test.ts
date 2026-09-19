import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { HarnessSteer } from '../src/lib/acpx/types';
import { runCodexAppServer } from '../src/lib/real-agents/codex-app-server';
import { executeCodexTask, resumeCodexSession } from '../src/lib/real-agents/codex-agent';

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-steering-'));
  const log = path.join(dir, 'requests.jsonl');
  await writeFile(path.join(dir, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const mode = process.env.CODEX_STEER_MODE;
const log = process.env.CODEX_STEER_LOG;
const emit = x => process.stdout.write(JSON.stringify(x)+'\\n');
if (process.argv[2] !== 'app-server') {
  fs.appendFileSync(log, JSON.stringify({method:'exec'})+'\\n');
  emit({type:'item.completed',item:{type:'agent_message',text:'fallback'}});
  process.exit(0);
}
const complete = () => emit({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
const reply = (c,result) => emit({id:c.id,result});
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const c=JSON.parse(line); fs.appendFileSync(log,line+'\\n');
  if(c.method==='initialize') {
    if(mode==='bootstrap-exit') process.exit(2);
    if(mode==='bootstrap-hang') return;
    reply(c,{});
  }
  if(c.method==='thread/start'||c.method==='thread/resume') reply(c,{thread:{id:'thread-1'}});
  if(c.method==='turn/start') {
    if(mode==='start-exit') process.exit(2);
    if(mode==='start-lost') return;
    reply(c,{turn:{id:'turn-1'}});
    emit({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-1'}}});
    // Foreign completions must not unregister this turn.
    emit({method:'turn/completed',params:{threadId:'other',turn:{id:'turn-1',status:'completed'}}});
    emit({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'old',status:'completed'}}});
    if(mode==='immediate') complete();
    else if(!['hang','unknown-timeout'].includes(mode)) setTimeout(complete,100);
  }
  if(c.method==='turn/steer') {
    if(mode==='exit') process.exit(2);
    if(mode==='unknown'||mode==='unknown-timeout'||mode==='hang') return;
    if(mode==='reject') return emit({id:c.id,error:{code:-32600,message:'No active turn'}});
    if(mode==='unsupported') return emit({id:c.id,error:{code:-32601,message:'Method not found'}});
    if(mode==='race') { complete(); setTimeout(()=>reply(c,{turnId:'turn-1'}),50); return; }
    reply(c,mode==='malformed'?{}:{turnId:mode==='wrong-id'?'other':'turn-1'});
  }
});
`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, CODEX_STEER_MODE: process.env.CODEX_STEER_MODE, CODEX_STEER_LOG: process.env.CODEX_STEER_LOG };
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.CODEX_STEER_LOG = log;
  const commands = async () => (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  try {
    let control!: HarnessSteer;
    let receipts: Promise<string>[] = [];
    const run = async (mode: string, timeout = 2_000) => {
      await writeFile(log,''); process.env.CODEX_STEER_MODE=mode;
      let disposed=0, ready=0;
      receipts=[];
      const result = await runCodexAppServer({prompt:'original',workingDirectory:dir,sandboxMode:'read-only',approvalPolicy:'never',timeout,
        streamCallbacks:{onSteeringReady: steer => {
          ready++; control=steer;
          receipts=[steer('first','FIRST'),steer('first','FIRST'),steer('second','SECOND')];
          return () => { disposed++; };
        }},
      }).then(output=>({output,error:''}),error=>({output:null,error:String(error)}));
      assert.equal(ready,1); assert.equal(disposed,1);
      assert.equal(receipts[0],receipts[1]);
      assert.equal(await control('late','LATE'),'rejected');
      const calls=await commands();
      const steering=calls.filter(c=>c.method==='turn/steer');
      assert.deepEqual(steering.map(c=>c.params.input[0].text),mode==='exit'?['FIRST']:['FIRST','SECOND']);
      assert.ok(steering.every(c=>c.params.threadId==='thread-1'&&c.params.expectedTurnId==='turn-1'));
      assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
      assert.equal(calls.filter(c=>c.method==='exec').length,0);
      return result;
    };
    await run('success');
    assert.deepEqual(await Promise.all(receipts),['accepted','accepted','accepted']);
    assert.equal(await control('first','FIRST'),'accepted');
    for(const mode of ['reject','unsupported']) {
      await run(mode); assert.deepEqual(await Promise.all(receipts),['rejected','rejected','rejected']);
    }
    for(const mode of ['unknown','race','malformed','wrong-id','exit','hang','unknown-timeout']) {
      const result=await run(mode,mode==='unknown-timeout'?5_500:500);
      assert.deepEqual(await Promise.all(receipts),['unknown','unknown','unknown'],mode);
      if(['exit','hang','unknown-timeout'].includes(mode)) assert.ok(result.error);
      assert.equal(await control('first','FIRST'),'unknown','unknown never replays');
    }
    // Stop in startup must settle the pending request and must not execute JSON fallback.
    await writeFile(log,''); process.env.CODEX_STEER_MODE='bootstrap-hang';
    let child!: ChildProcess;
    const stopped=await executeCodexTask({id:'stop',name:'stop'},{workingDirectory:dir,timeout:1_000,
      onSpawn: process => { child=process; setTimeout(()=>child.kill('SIGTERM'),50); },
      streamCallbacks:{onSteeringReady:()=>{throw Error('unexpected ready');}},
    });
    assert.equal(stopped.success,false); assert.equal((await commands()).some(c=>c.method==='exec'),false);
    for(const mode of ['bootstrap-exit','start-exit','start-lost']) {
      await writeFile(log,''); process.env.CODEX_STEER_MODE=mode;
      const result=await executeCodexTask({id:mode,name:mode},{workingDirectory:dir,approvalPolicy:'never',timeout:300,
        streamCallbacks:{onSteeringReady:()=>{throw Error('unexpected ready');}},
      });
      assert.equal(result.success,mode==='bootstrap-exit');
      assert.equal((await commands()).filter(c=>c.method==='exec').length,mode==='bootstrap-exit'?1:0);
    }
    await writeFile(log,''); process.env.CODEX_STEER_MODE='success';
    let resumeReceipt!: Promise<string>;
    await resumeCodexSession({threadId:'saved',prompt:'continue',timeout:2_000,workingDirectory:dir,approvalPolicy:'never',
      streamCallbacks:{onSteeringReady:steer=>{resumeReceipt=steer('resume','RESUME');return ()=>{};}},
    });
    assert.equal(await resumeReceipt,'accepted');
    assert.ok((await commands()).some(c=>c.method==='thread/resume'&&c.params.threadId==='saved'));
    console.log('Codex steering: IDs, dedup, order, receipts, completion race, exit, timeout, resume and safe JSON fallback passed');
  } finally {
    for(const [key,value] of Object.entries(saved)) { if(value===undefined) delete process.env[key]; else process.env[key]=value; }
    await rm(dir,{recursive:true,force:true});
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
