import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCodexAppServer } from '../src/lib/real-agents/codex-app-server';
import { executeCodexTask, resumeCodexSession } from '../src/lib/real-agents/codex-agent';
import { withSandbox } from '../src/lib/sandbox-manager';
import type { HarnessSandbox } from '../src/lib/harness/types';

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'managed-codex-'));
  const bin = path.join(root, 'bin'); mkdirSync(bin);
  const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  const config = path.join(workspace, '.codex'); mkdirSync(config);
  const executable = path.join(bin, 'codex');
  writeFileSync(executable, `#!${process.execPath}
const fs=require('fs');
if(process.argv[2]!=='app-server') {
  process.stdin.resume();process.stdin.on('end',()=>{
    console.log(JSON.stringify({type:'thread.started',thread_id:'native-fixture'}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'json completed'}}));
    console.log(JSON.stringify({type:'turn.completed'}));
  });
} else {
  const rl=require('readline').createInterface({input:process.stdin});
  rl.on('line',line=>{
    const m=JSON.parse(line);if(!m.id)return;
    let result={};
    if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'native-fixture'}};
    console.log(JSON.stringify({id:m.id,result}));
    if(m.method==='turn/start'){
      console.log(JSON.stringify({method:'item/agentMessage/delta',params:{delta:'protocol complete'}}));
      console.log(JSON.stringify({method:'turn/completed',params:{threadId:'native-fixture',turn:{id:'turn-fixture',status:'completed'}}}));
    }
  });
}
`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  try {
    let managedClosed = false;
    let launches = 0;
    const sandbox: HarnessSandbox = { run: (input, use) => {
      launches++;
      return withSandbox(input, async managed => {
        managed.control.onClosed(() => { managedClosed = true; });
        return use(managed);
      });
    } };
    const options = { workingDirectory: workspace, workspaceRoot: workspace, codexHome: config,
      networkAccess: 'restricted' as const, sandboxMode: 'workspace-write', approvalPolicy: 'never' as const,
      timeout: 5000, sandbox, env: process.env };
    if (process.env.S01_LEGACY_BASELINE === '1') {
      let closed = false;
      await runCodexAppServer({ ...options, sandbox: undefined, prompt: 'baseline', onSpawn: child => {
        child.once('close', () => { closed = true; });
      } });
      assert.equal(closed, true, 'protocol success must wait for root close before resolving');
    }
    const first = await runCodexAppServer({ ...options, prompt: 'first' });
    assert.equal(first.threadId, 'native-fixture');
    assert.equal(managedClosed, true, 'protocol success must wait for root close before resolving');
    managedClosed = false;
    const second = await runCodexAppServer({ ...options, prompt: 'followup', threadId: first.threadId });
    assert.equal(second.threadId, first.threadId);
    assert.equal(managedClosed, true);
    const json = await executeCodexTask({ id: 'json-fixture', name: 'json fixture' }, options);
    assert.equal(json.success, true, json.error);
    assert.equal(json.threadId, first.threadId);
    const resumed = await resumeCodexSession({ ...options, threadId: first.threadId, prompt: 'json resume' });
    assert.equal(resumed.threadId, first.threadId);
    assert.equal(launches, 4, 'both protocols and resumes must use the same launch scope');
    console.log('PASS real Bubblewrap Codex app-server/JSON execute+resume; original session; protocol success awaits close');
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
