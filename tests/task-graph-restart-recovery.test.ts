import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, releaseReadyNodes, claimNode, claimExecution, recordExecutionDispatch } from '../src/lib/task-graph/store';
import { getHarnessAdapter } from '../src/lib/harness';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { executionProgress, applyExecutionOutcome, bindExecutionTaskRun } from '../src/lib/task-graph/execution-progress';
import { ensureIntegrationRef, ensureJobWorktree, commitJobWorktree } from '../src/lib/task-graph/worktree';
import type { GraphDefinition } from '../src/lib/task-graph/domain';
import { observeGraphWriter } from '../src/lib/task-graph/writer-ownership';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-restart-'));
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  await fs.writeFile(path.join(repository, 'base'), 'base'); git('add', '.'); git('commit', '-m', 'base');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime'); process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation'); process.env.TASK_GRAPH_UPSTREAM_ROOT = path.join(root, 'upstream');
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'fixture' } }));
  const parent = await prisma.task.create({ data: { name: 'restart' } });
  const definition: GraphDefinition = { specRef: 'fixture://restart', nodes: [{
    key: 'N', goal: 'recover', dependsOn: [], executionMode: 'lean', acceptance: { mode: 'automatic', checks: ['done'] }, executions: [{
      key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'local:codex', instructions: 'fixture',
      launchConfig: { participant: { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' }, checks: [{ name: 'done', argv: ['test', '-f', 'done'] }] },
    }],
  }] };
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition });
  const script = path.join(root, 'old-owner.cjs');
  const cwd = process.cwd();
  await fs.writeFile(script, `
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const {prisma}=require(${JSON.stringify(path.join(cwd, 'src/lib/prisma.ts'))});
const {getHarnessAdapter}=require(${JSON.stringify(path.join(cwd, 'src/lib/harness/index.ts'))});
const {runTaskGraphCycle}=require(${JSON.stringify(path.join(cwd, 'src/lib/task-graph/coordinator.ts'))});
globalThis.fetch=async()=>new Response(JSON.stringify({code:0,data:{message_id:'fixture'}}));
getHarnessAdapter('codex').execute=async({task,context})=>{
 const job=await prisma.taskGraphExecution.findUniqueOrThrow({where:{childTaskId:task.id}});
 const run=await prisma.taskRun.findUniqueOrThrow({where:{id:job.taskRunId}});
 const writer=JSON.parse(run.controlMetadata).graphWriter;
 if(!writer||context.taskEnvironment.AP_GRAPH_WRITER_NONCE!==writer.nonce)throw new Error('Writer not persisted before launch');
 fs.writeFileSync(path.join(context.workingDirectory,'partial'),'preserved');
 const child=spawn(process.execPath,['-e','process.stdout.write("ready");setInterval(()=>{},1000)'],{env:{...process.env,...context.taskEnvironment},detached:true,stdio:['ignore','pipe','pipe']});
 child.stdout.once('data',()=>process.send({pid:child.pid,executionId:job.id,taskRunId:run.id,writer}));
 return new Promise(()=>{});
};
(async()=>{await runTaskGraphCycle();setInterval(()=>{},1000)})().catch(e=>{console.error(e);process.exit(1)});
`);
  let phaseOwner: ChildProcess | undefined; let supervisor: ChildProcess | undefined; let orphanPid: number | undefined;
  try {
    supervisor = fork(script, [], { cwd, env: { ...process.env, TS_NODE_BASEURL: '.', TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs","moduleResolution":"node"}' },
      execArgv: ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let diagnostics = ''; supervisor.stderr?.on('data', chunk => { diagnostics += chunk; });
    const deadline = setTimeout(() => supervisor?.kill('SIGTERM'), 20_000);
    const launched = await Promise.race([once(supervisor, 'message').then(([message]) => message), once(supervisor, 'exit').then(async () => { throw new Error(JSON.stringify({ diagnostics, nodes: await prisma.taskGraphNode.findMany({ where: { runId: run.id }, include: { executions: true } }), events: await prisma.taskGraphEvent.findMany({ where: { runId: run.id }, orderBy: { createdAt: 'desc' }, take: 4 }) })); })]);
    clearTimeout(deadline);
    assert(launched && typeof launched === 'object');
    const pid: unknown = Reflect.get(launched, 'pid'); const executionId: unknown = Reflect.get(launched, 'executionId'); const taskRunId: unknown = Reflect.get(launched, 'taskRunId');
    assert.equal(typeof pid, 'number'); assert.equal(typeof executionId, 'string'); assert.equal(typeof taskRunId, 'string');
    if (typeof pid !== 'number' || typeof executionId !== 'string' || typeof taskRunId !== 'string') throw new Error('Invalid child identity');
    orphanPid = pid;
    const writer: unknown = Reflect.get(launched, 'writer');
    const exit = once(supervisor, 'exit'); supervisor.kill('SIGKILL'); await exit;
    assert.equal((await observeGraphWriter(writer)).kind, 'alive', 'Orphaned harness must prevent takeover after coordinator dies');
    let newStarts = 0;
    getHarnessAdapter('codex')!.execute = async ({ context }) => { newStarts++; assert.equal(await fs.readFile(path.join(context.workingDirectory!, 'partial'), 'utf8'), 'preserved'); await fs.writeFile(path.join(context.workingDirectory!, 'done'), 'done'); return { success: true, executionTime: 1, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"recovered","evidence":["done"]}' }; };
    const original = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId } });
    for (let n = 0; n < 2; n++) await runTaskGraphCycle();
    assert.equal(newStarts, 0); assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId } })).claimToken, original.claimToken);
    process.kill(pid, 'SIGTERM'); orphanPid = undefined;
    for (let n = 0; n < 200 && (await observeGraphWriter(writer)).kind !== 'exited'; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await observeGraphWriter(writer)).kind, 'exited');
    for (let n = 0; n < 300; n++) {
      await runTaskGraphCycle();
      if ((await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'N' } } })).status === 'passed') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal);
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'N' } } })).status, 'passed', 'Confirmed writer exit must recover automatically without human resume');
    assert.equal(newStarts, 1);
    assert.equal((await prisma.taskRun.findUniqueOrThrow({ where: { id: taskRunId } })).status, 'interrupted');
    const completed = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: executionId } });
    assert(executionProgress(completed.dispatchMetadata)?.candidateCommit);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'implementation_recovery_requested' } }), 0);
    const secondParent = await prisma.task.create({ data: { name: 'completed candidate pickup' } });
    const second = await createTaskGraphRun({ parentTaskId: secondParent.id, version: 1, requestKey: secondParent.id, definition });
    const token = 'completed-candidate-owner';
    await releaseReadyNodes(second.id); await claimNode(second.id, 'N', token); const job = await claimExecution(second.id, 'N', 'repo', token); assert(job);
    const integration = await ensureIntegrationRef({ repoPath: repository, runId: second.id, baseRef: job.gitRef, baseCommit: job.baseCommit });
    const workspace = await ensureJobWorktree({ repoPath: repository, runId: second.id, jobId: job.id, baseRef: integration.ref, baseCommit: job.baseCommit });
    await fs.writeFile(path.join(workspace.path, 'partial'), 'preserved'); await fs.writeFile(path.join(workspace.path, 'done'), 'done');
    const candidate = await commitJobWorktree({ repoPath: repository, runId: second.id, jobId: job.id, message: 'completed candidate' });
    const task = await prisma.task.create({ data: { id: `task-graph-${job.id}`, name: 'completed before restart' } });
    await recordExecutionDispatch({ runId: second.id, nodeKey: 'N', executionKey: 'repo', claimToken: token, childTaskId: task.id, worktreePath: workspace.path, worktreeBranch: workspace.branch });
    const checkpoint = await applyExecutionOutcome({ executionId: job.id, claimToken: token, expectedRevision: 0, outcomeId: 'fixture-integrate', outcome: { kind: 'checkpoint', phase: 'integrate', candidateCommit: candidate, workspaceBase: job.baseCommit } });
    const saved = await prisma.$transaction(async tx => {
      const created = await tx.taskRun.create({ data: { taskId: task.id, mode: 'acpx', status: 'completed', summary: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"saved","evidence":["done"]}',
        controlMetadata: '{}', participants: { create: { gatewayNameSnapshot: 'Platform Local', runner: 'codex', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer', status: 'completed', summary: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"saved","evidence":["done"]}' } } } });
      await bindExecutionTaskRun(tx, { executionId: job.id, claimToken: token, revision: checkpoint.revision }, created.id); return created;
    });
    await runTaskGraphCycle();
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).claimToken, token, 'Completed database status without process proof must not authorize takeover');
    await prisma.taskRun.update({ where: { id: saved.id }, data: { controlMetadata: JSON.stringify({ graphWriter: writer }) } });
    const phaseScript = path.join(root, 'phase-owner.cjs');
    const gate = path.join(root, 'release-check');
    await fs.writeFile(phaseScript, `
const fs=require('node:fs');
const {prisma}=require(${JSON.stringify(path.join(cwd, 'src/lib/prisma.ts'))});
const checks=require(${JSON.stringify(path.join(cwd, 'src/lib/task-graph/check-environment.ts'))});
const originalCheck=checks.runSandboxedGraphCheck;
let notified=false;
checks.runSandboxedGraphCheck=async(...args)=>{
 if(!notified){notified=true;process.send({kind:'checking'});while(!fs.existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,10));}
 return originalCheck(...args);
};
const {runTaskGraphCycle,startTaskGraphCoordinator}=require(${JSON.stringify(path.join(cwd, 'src/lib/task-graph/coordinator.ts'))});
globalThis.fetch=async()=>new Response(JSON.stringify({code:0,data:{message_id:'fixture'}}));
(async()=>{
 for(let n=0;n<1000;n++){
  await runTaskGraphCycle();
  const node=await prisma.taskGraphNode.findUniqueOrThrow({where:{runId_key:{runId:${JSON.stringify(second.id)},key:'N'}}});
  if(node.status==='passed'){const abort=new AbortController();abort.abort();await startTaskGraphCoordinator(abort.signal);process.send({kind:'done'});await prisma.$disconnect();process.exit(0);}
  await new Promise(r=>setTimeout(r,20));
 }
 throw new Error('Phase worker did not finish');
})().catch(e=>{console.error(e);process.exit(1)});
`);
    phaseOwner = fork(phaseScript, [], { cwd, env: { ...process.env, TS_NODE_BASEURL: '.', TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs","moduleResolution":"node"}' }, execArgv: ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const phaseDeadline = setTimeout(() => phaseOwner?.kill('SIGTERM'), 30_000);
    const [checking] = await Promise.race([once(phaseOwner, 'message'), once(phaseOwner, 'exit').then(() => { throw new Error('Phase owner exited before check'); })]);
    assert.deepEqual(checking, { kind: 'checking' });
    const activePhase = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    const phaseProgress = executionProgress(activePhase.dispatchMetadata);
    assert.equal(phaseProgress?.worker?.supervisor.pid, phaseOwner.pid, 'Resumed platform check persists its current owner before running');
    assert.equal(activePhase.taskRunId, saved.id, 'Old model TaskRun is retained as evidence, independently of the live phase owner');
    for (let n = 0; n < 3; n++) await runTaskGraphCycle();
    const duringCheck = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(duringCheck.claimToken, activePhase.claimToken, 'Second coordinator cannot reclaim a live post-Agent phase');
    assert.equal(executionProgress(duringCheck.dispatchMetadata)?.worker?.nonce, phaseProgress?.worker?.nonce);
    assert.equal(newStarts, 1, 'Concurrent coordinator does not launch another implementation or check owner');
    const phaseExit = once(phaseOwner, 'exit'); await fs.writeFile(gate, 'release'); await phaseExit; clearTimeout(phaseDeadline);
    assert.equal(phaseOwner.exitCode, 0);
    const drain = new AbortController(); drain.abort(); await startTaskGraphCoordinator(drain.signal);
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: second.id, key: 'N' } } })).status, 'passed');
    assert.equal(newStarts, 1, 'Completed candidate resumes checks/integration without another implementation Agent');
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).commit, candidate);
    console.log('Real coordinator death preserves an orphan writer; confirmed exit automatically resumes once with source preserved and zero human resume');
  } finally {
    if (phaseOwner && phaseOwner.exitCode === null && phaseOwner.signalCode === null) phaseOwner.kill('SIGKILL');
    if (orphanPid) try { process.kill(orphanPid, 'SIGKILL'); } catch {}
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL');
    const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal);
    await prisma.$disconnect(); await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
