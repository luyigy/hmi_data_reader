import assert from 'node:assert/strict';
import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';
import { getHarnessAdapter } from '../src/lib/harness';
import type { GraphDefinition } from '../src/lib/task-graph/domain';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_[a-f0-9]+$/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-saved-acceptance-')), repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'fixture@example.test');
  await fs.writeFile(path.join(repository, 'value'), 'base'); git('add', '.'); git('commit', '-m', 'base');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime'); process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const definition: GraphDefinition = { specRef: 'fixture://saved-acceptance', nodes: [{ key: 'N', goal: 'deliver', dependsOn: [], executionMode: 'lean',
    acceptance: { mode: 'agent', reviewerId: 'local:kimi-code', checks: ['done'], reviewLaunchConfig: { participant: { ...participant, harnessType: 'kimi-code', role: 'tester' } } },
    executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'local:codex', instructions: 'deliver', launchConfig: { participant, checks: [{ name: 'done', argv: ['test', '-f', 'value'] }] } }] }] };
  definition.nodes.push({ ...definition.nodes[0], key: 'NEXT', dependsOn: ['N'], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] } });
  const parent = await prisma.task.create({ data: { name: 'saved acceptance restart' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition });
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'N' } } });
  const cwd = process.cwd(), script = path.join(root, 'old-coordinator.cjs');
  await fs.writeFile(script, `
const fs=require('node:fs'),path=require('node:path');
const {getHarnessAdapter}=require(${JSON.stringify(path.join(cwd,'src/lib/harness/index.ts'))});
const store=require(${JSON.stringify(path.join(cwd,'src/lib/task-graph/store.ts'))});
const feishu=require(${JSON.stringify(path.join(cwd,'src/lib/task-graph/feishu.ts'))});
feishu.ensureGraphChildTopic=async()=>null;feishu.postGraphParentProgress=async()=>{};feishu.postGraphChildProgress=async()=>{};
require(${JSON.stringify(path.join(cwd,'src/lib/feishu-api.ts'))}).getFeishuTenantAccessToken=async()=>'fixture';
globalThis.fetch=async()=>new Response(JSON.stringify({code:0,data:{message_id:'fixture'}}));
getHarnessAdapter('codex').execute=async({context})=>{fs.writeFileSync(path.join(context.workingDirectory,'value'),'delivered');return {success:true,executionTime:1,output:'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"done","evidence":["value"]}'};};
getHarnessAdapter('kimi-code').execute=async({context})=>{fs.writeFileSync(path.join(context.workingDirectory,'saved-report.txt'),'original evidence');return {success:true,executionTime:1,output:'TASK_GRAPH_REVIEW {"approved":true,"note":"real review completed"}'};};
const publish=store.submitNodeVerification;
store.submitNodeVerification=async args=>{if(args.review?.phase==='acceptance'){process.send({taskRunId:args.review.taskRunId});return new Promise(()=>{});}return publish(args);};
const {runTaskGraphCycle}=require(${JSON.stringify(path.join(cwd,'src/lib/task-graph/coordinator.ts'))});
(async()=>{await runTaskGraphCycle();setInterval(()=>runTaskGraphCycle().catch(console.error),50)})().catch(e=>{console.error(e);process.exit(1)});
`);
  let child: ChildProcess | undefined;
  const require = createRequire(__filename); const feishu = require('../src/lib/task-graph/feishu');
  feishu.ensureGraphChildTopic = async () => null; feishu.postGraphParentProgress = async () => {}; feishu.postGraphChildProgress = async () => {};
  require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
  const fetch = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'fixture' } }));
  try {
    child = fork(script, [], { cwd, env: process.env, execArgv: ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'], stdio: ['ignore','pipe','pipe','ipc'] });
    let diagnostics = ''; child.stderr?.on('data', chunk => { diagnostics += chunk; });
    const deadline = setTimeout(() => child?.kill('SIGTERM'), 30_000);
    const saved = await Promise.race([once(child,'message').then(([message]) => message), once(child,'exit').then(() => { throw new Error(diagnostics); })]); clearTimeout(deadline);
    assert(saved && typeof saved === 'object'); const savedTaskRunId: unknown = Reflect.get(saved,'taskRunId'); assert.equal(typeof savedTaskRunId,'string');
    const receipt = await prisma.taskGraphEvent.findFirstOrThrow({ where: { nodeId: node.id, kind: 'acceptance_runtime_prepared' } });
    const directory = (receipt.payload as { directory: string }).directory;
    assert.equal(await fs.readFile(path.join(directory,'saved-report.txt'),'utf8'),'original evidence');
    const exit = once(child,'exit'); child.kill('SIGKILL'); await exit;
    let implementationStarts = 0, reviewerStarts = 0;
    getHarnessAdapter('codex')!.execute = async ({ task, context }) => { implementationStarts++; assert.match(task.name,/^NEXT/); await fs.writeFile(path.join(context.workingDirectory!,'next'),'next'); return { success:true,executionTime:1,output:'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"next","evidence":["next"]}' }; };
    getHarnessAdapter('kimi-code')!.execute = async () => { reviewerStarts++; throw new Error('Saved result must not start another reviewer'); };
    for(let n=0;n<400;n++){ await runTaskGraphCycle(); if((await prisma.taskGraphRun.findUniqueOrThrow({where:{id:run.id}})).status==='completed_unverified')break; await new Promise(resolve=>setTimeout(resolve,25)); }
    const abort=new AbortController();abort.abort();await startTaskGraphCoordinator(abort.signal);
    assert.equal((await prisma.taskGraphRun.findUniqueOrThrow({where:{id:run.id}})).status,'completed_unverified',diagnostics);
    assert.equal(implementationStarts,1,'Only successor starts after restart');assert.equal(reviewerStarts,0);
    const after=await prisma.taskGraphEvent.findMany({where:{nodeId:node.id,kind:'acceptance_runtime_prepared'}});assert.equal(after.length,1);assert.deepEqual(after[0],receipt,'Original receipt and runtime evidence are reused');
    assert.equal(await prisma.taskRun.count({where:{taskId:`task-graph-review-${node.id}`}}),1);
    const retained = await prisma.taskGraphEvent.findFirstOrThrow({ where: { nodeId: node.id, kind: 'workspace_cleanup_deferred' } });
    assert.match(JSON.stringify(retained.payload), /Task or Session still references/, 'Live native Session references keep the original worktree');
    assert.equal(await fs.readFile(path.join(directory, 'saved-report.txt'), 'utf8'), 'original evidence', 'Saved reviewer report remains readable at its original receipt');
    console.log('Actual coordinator death after completed acceptance consumes saved result, preserves runtime receipt/report, starts successor without another Agent or human resume');
  } finally { if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');globalThis.fetch=fetch;await prisma.$disconnect();await fs.rm(root,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
