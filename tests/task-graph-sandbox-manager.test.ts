import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { withSandbox } from '../src/lib/sandbox-manager';
import { observeTaskRunWriter } from '../src/lib/task-graph/writer-ownership';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { runTaskGraphCycle } from '../src/lib/task-graph/coordinator';
import { receiveGraphTaskMessage } from '../src/lib/task-graph/conversation-inbox';
import { executionProgress } from '../src/lib/task-graph/execution-progress';

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'graph-manager-'));
  const repository = path.join(root, 'repo'); mkdirSync(repository);
  const bin = path.join(root, 'bin'); mkdirSync(bin);
  const home = path.join(root, 'codex'); mkdirSync(home);
  const runtime = path.join(root, 'runtime');
  const previous = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME,
    TASK_GRAPH_RUNTIME_ROOT: process.env.TASK_GRAPH_RUNTIME_ROOT };
  const git = (...argv: string[]) => execFileSync('git', argv, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  writeFileSync(path.join(repository, 'base'), 'fixture'); git('add', '.'); git('commit', '-m', 'base');
  const baseCommit = git('rev-parse', 'HEAD');
  writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
const fs=require('fs');
if(process.argv[2]!=='app-server')throw Error('Ticket must use native app-server');
const rl=require('readline').createInterface({input:process.stdin});
rl.on('line',line=>{
 const m=JSON.parse(line);if(!m.id)return;
 let result={};if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'managed-ticket-native'}};
 if(m.method==='account/rateLimits/read')result={};
 console.log(JSON.stringify({id:m.id,result}));
 if(m.method==='turn/start'){
   const text=JSON.stringify(m.params.input);
   let answer;
   if(text.includes('尺寸使用42')){
     fs.writeFileSync('done','42');
     let denied=false;try{fs.writeFileSync(require('path').join(fs.readFileSync('.git','utf8').trim().replace(/^gitdir: /,''),'forbidden'),'bad')}catch{denied=true}
     if(!denied)throw Error('Git metadata must remain readonly');
     answer='TASK_GRAPH_IMPLEMENTATION '+JSON.stringify({status:'delivered',note:'material applied',evidence:['done']});
   }else answer='TASK_GRAPH_IMPLEMENTATION '+JSON.stringify({status:'blocked',blockerKind:'missing_business_material',note:'请告诉我尺寸'});
   console.log(JSON.stringify({method:'item/agentMessage/delta',params:{delta:answer}}));
   console.log(JSON.stringify({method:'turn/completed',params:{threadId:'managed-ticket-native',turn:{id:'turn',status:'completed'}}}));
 }
});
`, { mode: 0o700 });
  process.env.PATH = bin + path.delimiter + previous.PATH;
  process.env.CODEX_HOME = home; process.env.TASK_GRAPH_RUNTIME_ROOT = runtime;
  try {
    const owner = await prisma.user.create({ data: { username: root, passwordHash: 'fixture-only', role: 'user' } });
    const parent = await prisma.task.create({ data: { name: 'sandbox manager isolated', ownerUserId: owner.id } });
    const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
    const definition = { specRef: 'test://sandbox-manager', nodes: [{ key: 'T', goal: 'fill size', dependsOn: [],
      executionMode: 'lean' as const, acceptance: { mode: 'automatic' as const, checks: ['done'] }, executions: [{ key: 'one', repository,
        gitRef: 'refs/heads/main', baseCommit, agentSelector: 'local:codex', instructions: 'Use real size',
        launchConfig: { participant, checks: [{ name: 'done', argv: ['node', '-e', "require('assert').equal(require('fs').readFileSync('done','utf8'),'42')"] }] } }] }] };
    const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition });
    const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id } } });
    const waitFor = async (predicate: () => Promise<boolean>) => {
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        await runTaskGraphCycle();
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Isolated manager Ticket did not reach expected condition');
    };
    await waitFor(async () => executionProgress((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).dispatchMetadata)?.state === 'waiting_for_user');
    const waiting = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    assert(waiting.childTaskId);
    await receiveGraphTaskMessage({ taskId: waiting.childTaskId, actorId: owner.id, actorOrigin: 'platform',
      sourceId: 'managed-size', content: '尺寸使用42' });
    await waitFor(async () => (await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: job.nodeId } })).status === 'passed');
    const runs = await prisma.taskRun.findMany({ where: { taskId: waiting.childTaskId }, orderBy: { createdAt: 'asc' }, include: { participants: true, events: true } });
    assert.equal(runs.length, 2);
    assert.equal(runs[0].taskSessionId, runs[1].taskSessionId);
    for (const run of runs) {
      const metadata = JSON.parse(run.participants[0].controlMetadata || '{}');
      assert.equal(metadata.lastSessionId || metadata.codexThreadId, 'managed-ticket-native');
      const managed = run.events.filter(event => event.metadata && JSON.parse(event.metadata).sandboxIdentity);
      assert.equal(managed.length, 1, 'real ACPX Ticket must record one Manager root identity');
      const identity = JSON.parse(managed[0].metadata!).sandboxIdentity;
      assert.equal(identity.backend, 'bubblewrap');
      assert(identity.root.pid > 0 && /^\d+$/.test(identity.root.startTime));
    }
    const terminal = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(terminal.status, 'integrated');
    const writer = JSON.parse(runs[1].controlMetadata || '{}').graphWriter;
    const survivor = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], {
      env: { ...process.env, AP_GRAPH_WRITER_NONCE: writer.nonce }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await once(survivor.stdout!, 'data');
      await withSandbox({ command: '/usr/bin/true', commandArgs: [], cwd: root, workspaceRoot: root,
        env: { ...process.env, AP_GRAPH_WRITER_NONCE: writer.nonce } }, async managed => {
        await once(managed.child, 'close');
      });
      const observation = await observeTaskRunWriter(runs[1].id);
      assert.equal(observation.kind, 'alive', JSON.stringify(observation));
      if (observation.kind === 'alive') assert(survivor.pid && observation.pids.includes(survivor.pid));
      console.log('PASS Manager root closed while same GraphWriter nonce descendant survives: Writer remains alive');
    } finally {
      const exited = once(survivor, 'exit'); survivor.kill('SIGTERM'); await exited;
    }

    console.log(JSON.stringify({ result: 'passed', runId: run.id, taskRuns: runs.map(run => run.id),
      sessions: runs.map(run => run.taskSessionId), nativeSession: 'managed-ticket-native', node: 'passed',
      repairAttempts: executionProgress(terminal.dispatchMetadata)?.repairAttempts }));
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
