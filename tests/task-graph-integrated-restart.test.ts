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

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_[a-f0-9]+$/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-integrated-restart-'));
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'fixture@example.test');
  await fs.writeFile(path.join(repository, 'value'), 'base'); git('add', '.'); git('commit', '-m', 'base');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime'); process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const parent = await prisma.task.create({ data: { name: 'integrated boundary restart' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    specRef: 'fixture://integrated-restart', nodes: ['N', 'NEXT'].map(key => ({ key, goal: key, dependsOn: key === 'N' ? [] : ['N'], executionMode: 'lean',
      acceptance: { mode: 'automatic', checks: ['value'] }, executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'local:codex', instructions: 'deliver',
        launchConfig: { participant, checks: [{ name: 'value', argv: ['test', '-f', 'value'] }] } }] })) } });
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'N' } } });
  const cwd = process.cwd(), script = path.join(root, 'old-coordinator.cjs');
  await fs.writeFile(script, `
const fs=require('node:fs'),path=require('node:path');
const {getHarnessAdapter}=require(${JSON.stringify(path.join(cwd, 'src/lib/harness/index.ts'))});
const progress=require(${JSON.stringify(path.join(cwd, 'src/lib/task-graph/execution-progress.ts'))});
const feishu=require(${JSON.stringify(path.join(cwd, 'src/lib/task-graph/feishu.ts'))});
feishu.ensureGraphChildTopic=async()=>null;feishu.postGraphParentProgress=async()=>{};feishu.postGraphChildProgress=async()=>{};
require(${JSON.stringify(path.join(cwd, 'src/lib/feishu-api.ts'))}).getFeishuTenantAccessToken=async()=>'fixture';
globalThis.fetch=async()=>new Response(JSON.stringify({code:0,data:{message_id:'fixture'}}));
getHarnessAdapter('codex').execute=async({context})=>{fs.writeFileSync(path.join(context.workingDirectory,'value'),'delivered');return {success:true,executionTime:1,output:'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"done","evidence":["value"]}'};};
const apply=progress.applyExecutionOutcome;
progress.applyExecutionOutcome=async args=>{const result=await apply(args);if(args.outcome.kind==='integrated'){process.send({commit:args.outcome.commit});return new Promise(()=>{});}return result;};
const {runTaskGraphCycle}=require(${JSON.stringify(path.join(cwd, 'src/lib/task-graph/coordinator.ts'))});
(async()=>{await runTaskGraphCycle();setInterval(()=>{},1000)})().catch(e=>{console.error(e);process.exit(1)});
`);
  const require = createRequire(__filename); const feishu = require('../src/lib/task-graph/feishu');
  feishu.ensureGraphChildTopic = async () => null; feishu.postGraphParentProgress = async () => {}; feishu.postGraphChildProgress = async () => {};
  require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
  const fetch = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'fixture' } }));
  let child: ChildProcess | undefined;
  try {
    child = fork(script, [], { cwd, env: process.env, execArgv: ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let diagnostics = ''; child.stderr?.on('data', chunk => { diagnostics += chunk; });
    const deadline = setTimeout(() => child?.kill('SIGTERM'), 30_000);
    const [saved] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(diagnostics); })]); clearTimeout(deadline);
    assert(saved && typeof saved === 'object');
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: node.id } })).status, 'claimed');
    const jobs = await prisma.taskGraphExecution.findMany({ where: { nodeId: node.id } });
    assert(jobs.every(job => job.status === 'integrated'));
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    let implementationStarts = 0;
    getHarnessAdapter('codex')!.execute = async ({ task, context }) => {
      implementationStarts++; assert.match(task.name, /^NEXT/);
      await fs.writeFile(path.join(context.workingDirectory!, 'next'), 'next');
      return { success: true, executionTime: 1, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"next","evidence":["next"]}' };
    };
    for (let n = 0; n < 200; n++) {
      await runTaskGraphCycle();
      if ((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal);
    assert.equal((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).status, 'completed', 'All-integrated claimed node must resume acceptance after coordinator death');
    assert.equal(implementationStarts, 1, 'Only successor implementation starts after restart');
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: jobs[0].id } })).commit, Reflect.get(saved, 'commit'));
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'implementation_recovery_scheduled' } }), 0);
    console.log('SIGKILL after durable integrated outcome: automatic acceptance, successor once, original implementation never restarted, human resume 0');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    globalThis.fetch = fetch; await prisma.$disconnect(); await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
