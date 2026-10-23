import assert from 'node:assert/strict';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { withSandbox } from '../src/lib/sandbox-manager';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { getHarnessAdapter } from '../src/lib/harness';
import { createTaskGraphRun, releaseReadyNodes, claimNode, claimExecution, recordExecutionDispatch } from '../src/lib/task-graph/store';
import { applyExecutionOutcome, executionProgress, metadataWithProgress, type ExecutionOutcome } from '../src/lib/task-graph/execution-progress';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { releaseGraphExecutionWorker } from '../src/lib/task-graph/phase-worker';
import { ensureIntegrationRef, ensureJobWorktree, integrateJobWorktree, TaskGraphGitError } from '../src/lib/task-graph/worktree';
import { runTaskGraphCycle, startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';

async function main(completedBlocked = false, agentOwned = false) {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_[a-f0-9]+$/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-conflict-continuation-')), repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(repository, 'init', '-b', 'main'); git(repository, 'config', 'user.name', 'Test'); git(repository, 'config', 'user.email', 'fixture@example.test');
  await fs.writeFile(path.join(repository, 'contract.md'), 'base\n'); git(repository, 'add', '.'); git(repository, 'commit', '-m', 'base');
  const base = git(repository, 'rev-parse', 'HEAD');
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime'); process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
  const check = { name: 'both deliveries and latest integration', argv: [process.execPath, '-e', "const fs=require('fs'),s=fs.readFileSync('contract.md','utf8');if(!s.includes('first')||!s.includes('second')||!fs.existsSync('R04'))throw Error('delivery lost')"] };
  const parent = await prisma.task.create({ data: { name: 'legacy conflict continuation' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
    ...(agentOwned ? { deliveryContract: 'agent_owned_v1' as const } : {}), specRef: 'fixture://conflict', nodes: [{ key: 'N', goal: 'Preserve both approved contract deliveries', dependsOn: [],
      architectureReview: { reviewerId: 'local:kimi-code', reviewLaunchConfig: { participant: { ...participant, harnessType: 'kimi-code', role: 'reviewer' } } },
      acceptance: { mode: 'automatic', checks: [check.name], integrationChecks: [{ ...check, repository }] },
      executions: ['A', 'B', 'R04'].map(key => ({ key, repository, gitRef: 'refs/heads/main', baseCommit: base, agentSelector: 'local:codex', instructions: 'Preserve both contract sections; no change outside this ticket.', launchConfig: { participant, checks: key === 'B' ? [check] : [] } })) },
      { key: 'NEXT', goal: 'successor', dependsOn: ['N'], executionMode: 'lean', acceptance: { mode: 'automatic', checks: ['next'] },
        executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: base, agentSelector: 'local:codex', instructions: 'successor', launchConfig: { participant, checks: [{ name: 'next', argv: ['test', '-f', 'next'] }] } }] }] } });
  const require = createRequire(__filename); const notices = require('../src/lib/task-graph/feishu');
  notices.ensureGraphChildTopic = async () => null; notices.postGraphParentProgress = async () => {}; notices.postGraphChildProgress = async () => {};
  require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
  const fetch = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'fixture' } }));
  let child: ChildProcess | undefined;
  try {
    await releaseReadyNodes(run.id); await claimNode(run.id, 'N', 'seed');
    const integration = await ensureIntegrationRef({ repoPath: repository, runId: run.id, baseRef: 'refs/heads/main', baseCommit: base });
    const jobs = await Promise.all(['A', 'B', 'R04'].map(async key => { const job = await claimExecution(run.id, 'N', key, key); assert(job); return job; }));
    const apply = async (job: typeof jobs[number], outcome: ExecutionOutcome) => {
      const revision = executionProgress((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).dispatchMetadata)?.revision || 0;
      return applyExecutionOutcome({ executionId: job.id, claimToken: job.key, expectedRevision: revision, outcomeId: `${job.key}:${revision}`, outcome });
    };
    const trees = new Map<string, string>();
    for (const job of jobs) {
      const tree = await ensureJobWorktree({ repoPath: repository, runId: run.id, jobId: job.id, baseRef: integration.ref, baseCommit: base }); trees.set(job.key, tree.path);
      await fs.writeFile(path.join(tree.path, job.key === 'R04' ? 'R04' : 'contract.md'), job.key === 'R04' ? 'latest' : `base\n${job.key === 'A' ? 'first' : 'second'}\n`);
      git(tree.path, 'add', '.'); git(tree.path, 'commit', '-m', job.key);
      await recordExecutionDispatch({ runId: run.id, nodeKey: 'N', executionKey: job.key, claimToken: job.key, worktreePath: tree.path, worktreeBranch: tree.branch, dispatchMetadata: { integrationRef: integration.ref, workspaceBase: base } });
      await apply(job, { kind: 'checkpoint', phase: 'integrate', workspaceBase: base, candidateCommit: git(tree.path, 'rev-parse', 'HEAD') });
    }
    const [a, b, c] = jobs;
    const first = await integrateJobWorktree({ repoPath: repository, runId: run.id, jobId: a.id, baseCommit: base, integrationRef: integration.ref, expectedIntegrationCommit: base, verify: async () => {} });
    await apply(a, { kind: 'integrated', commit: first.commit, evidence: { checks: [] } });
    const writer = await createGraphWriter(); await apply(b, { kind: 'checkpoint', phase: 'integrate', worker: writer });
    let conflict: TaskGraphGitError | undefined;
    await assert.rejects(integrateJobWorktree({ repoPath: repository, runId: run.id, jobId: b.id, baseCommit: base, integrationRef: integration.ref, expectedIntegrationCommit: first.commit, verify: async () => {} }), error => {
      assert(error instanceof TaskGraphGitError && error.integration?.kind === 'conflict'); conflict = error; return true;
    });
    assert(conflict);
    await apply(b, { kind: 'decision_required', failure: { code: 'integration_conflict', detail: JSON.stringify({ integration: conflict.integration }) + '\nstdout maxBuffer length exceeded' } });
    await apply(b, { kind: 'decision_required', failure: { code: 'integration_conflict', detail: JSON.stringify({ integration: conflict.integration }) + '\nEarlier recovery: bad diagnostic suffix', requiresUserDecision: false } });
    await releaseGraphExecutionWorker(b.id, 'B', writer.nonce);
    const advanced = await integrateJobWorktree({ repoPath: repository, runId: run.id, jobId: c.id, baseCommit: base, integrationRef: integration.ref, expectedIntegrationCommit: first.commit, verify: async () => {} });
    await apply(c, { kind: 'integrated', commit: advanced.commit, evidence: { checks: [] } });
    const before = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: b.id } });
    const beforeProgress = executionProgress(before.dispatchMetadata)!;
    await prisma.taskGraphExecution.update({ where: { id: b.id }, data: { dispatchMetadata: metadataWithProgress(before.dispatchMetadata,
      { ...beforeProgress, worker: { ...writer, hostname: 'unobservable-test-host' } }) } });
    await runTaskGraphCycle(); await runTaskGraphCycle();
    const waiting = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: b.id } });
    assert.equal(waiting.status, 'attention'); assert.equal(executionProgress(waiting.dispatchMetadata)?.revision, beforeProgress.revision);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: b.nodeId, kind: 'writer_observation' } }), 1, 'Unknown writer observations are idempotent and do not consume repair attempts');
    await prisma.taskGraphExecution.update({ where: { id: b.id }, data: { dispatchMetadata: metadataWithProgress(before.dispatchMetadata, beforeProgress) } });
    const cwd = process.cwd(), script = path.join(root, 'interrupted-repair.cjs');
    await fs.writeFile(script, `
const {getHarnessAdapter}=require(${JSON.stringify(path.join(cwd, 'src/lib/harness/index.ts'))});
const feishu=require(${JSON.stringify(path.join(cwd, 'src/lib/task-graph/feishu.ts'))});
feishu.ensureGraphChildTopic=async()=>null;feishu.postGraphParentProgress=async()=>{};feishu.postGraphChildProgress=async()=>{};
require(${JSON.stringify(path.join(cwd, 'src/lib/feishu-api.ts'))}).getFeishuTenantAccessToken=async()=>'fixture';
globalThis.fetch=async()=>new Response(JSON.stringify({code:0,data:{message_id:'fixture'}}));
getHarnessAdapter('codex').execute=async({context})=>{process.send({directory:context.workingDirectory,output:context.taskEnvironment.AP_GRAPH_OUTPUT_DIR});return new Promise(()=>{});};
const {runTaskGraphCycle}=require(${JSON.stringify(path.join(cwd, 'src/lib/task-graph/coordinator.ts'))});
(async()=>{await runTaskGraphCycle();setInterval(()=>{},1000)})().catch(e=>{console.error(e);process.exit(1)});
`);
    child = fork(script, [], { cwd, env: process.env, execArgv: ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let diagnostics = ''; child.stderr?.on('data', chunk => { diagnostics += chunk; });
    const deadline = setTimeout(() => child?.kill('SIGTERM'), 30_000);
    const [interrupted] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(diagnostics); })]); clearTimeout(deadline);
    assert(interrupted && typeof interrupted === 'object');
    const pending = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: b.id } });
    assert.equal(pending.status, 'claimed'); assert(executionProgress(pending.dispatchMetadata)?.conflictRepair);
    assert(pending.taskRunId);
    const originalParticipant = await prisma.taskRunParticipant.findFirstOrThrow({ where: { taskRunId: pending.taskRunId } });
    await prisma.taskRunParticipant.update({ where: { id: originalParticipant.id }, data: { controlMetadata: JSON.stringify({ lastSessionId: 'demag-original-session', lastSessionKind: 'codex_thread' }) } });
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    if (completedBlocked) {
      const blocked = 'TASK_GRAPH_IMPLEMENTATION ' + JSON.stringify({ status: 'blocked', blockerKind: 'environment_failed', note: 'Source readonly; resolution requires platform application.' });
      await prisma.taskRun.update({ where: { id: pending.taskRunId }, data: { status: 'completed', summary: blocked, completedAt: new Date() } });
      await prisma.taskRunParticipant.update({ where: { id: originalParticipant.id }, data: { status: 'completed', summary: blocked } });
    }
    assert.equal(git(trees.get('B')!, 'rev-parse', 'MERGE_HEAD'), first.commit);
    let repairs = 0, successors = 0, architecture = 0, qualityReviews = 0, resumedMessage = '';
    let resumeCalls = 0;
    getHarnessAdapter('codex')!.execute = async ({ task, context }) => {
      if (task.id.startsWith('task-graph-review-')) {
        qualityReviews++;
        const checks = JSON.parse((task.description || '').match(/稳定检查 ID 和可回修执行：(\[[^\n]+\])。/)![1]);
        const workspaces = JSON.parse((task.description || '').match(/仓库检出目录: (\[[^\n]+\])\n证据:/)![1]);
        const directory = workspaces[workspaces.length - 1].path;
        if (task.name.startsWith('N')) execFileSync(check.argv[0], check.argv.slice(1), { cwd: directory, stdio: 'pipe' });
        else execFileSync('test', ['-f', 'next'], { cwd: directory });
        return { success: true, executionTime: 1, output: 'TASK_GRAPH_REVIEW ' + JSON.stringify({ approved: true, note: 'all approved commands verified on integrated inputs',
          checks: checks.map((item: { id: string }) => ({ name: item.id, passed: true, evidence: `real command passed on ${workspaces[workspaces.length - 1].commit}` })) }) };
      }
      if (task.name.startsWith('N ·')) {
        repairs++; assert.match(task.description || '', /受控冲突修复/); assert.notEqual(context.workingDirectory, trees.get('B'));
        assert.notEqual(context.workingDirectory, Reflect.get(interrupted, 'directory'), 'Interrupted repair retains its original output directory and starts a fresh artifact attempt');
        assert.notEqual(context.taskEnvironment?.AP_GRAPH_OUTPUT_DIR, Reflect.get(interrupted, 'output'));
        assert.match(task.description || '', /Preserve both contract sections/);
        assert(context.taskEnvironment?.AP_GRAPH_OUTPUT_DIR);
        const source = trees.get('B')!;
        const approvedOutput = context.taskEnvironment.AP_GRAPH_OUTPUT_DIR;
        const script = `const fs=require('fs'),assert=require('assert');assert.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(source, 'contract.md'))},'forbidden'));assert.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(source, 'outside-output'))},'forbidden'));fs.writeFileSync(${JSON.stringify(path.join(approvedOutput, 'resolution.json'))},JSON.stringify({files:[{path:'contract.md',content:'base\\nfirst\\nsecond\\n'}]}));`;
        await withSandbox({ command: process.execPath, commandArgs: ['-e', script], cwd: context.workingDirectory!, workspaceRoot: context.workspaceRoot!,
          sandboxMode: context.permissionConfig?.sandboxMode, readOnlyPaths: context.extraReadOnlyPaths, strictReadOnlyRoots: true,
          env: { ...process.env, ...context.taskEnvironment, AP_TASK_SANDBOX: '1' } }, async scope => {
          let stderr = ''; scope.child.stderr?.on('data', chunk => { stderr += chunk; });
          const [code] = await once(scope.child, 'close'); assert.equal(code, 0, stderr);
        });
        assert.match(await fs.readFile(path.join(source, 'contract.md'), 'utf8'), /<<<<<<</, 'Agent did not write the source');
      } else { successors++; await fs.writeFile(path.join(context.workingDirectory!, 'next'), 'done'); }
      return { success: true, executionTime: 1, output: 'TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"preserved delivery","evidence":["resolution"]}' };
    };
    getHarnessAdapter('codex')!.resume = async ({ task, context, sessionId, continuationMessage }) => {
      resumeCalls++; resumedMessage = continuationMessage;
      assert.equal(sessionId, 'demag-original-session');
      assert.match(continuationMessage, /受控冲突修复/, 'DEMAG Resume must receive current conflict stage');
      assert.match(continuationMessage, /resolution\.json/);
      assert(continuationMessage.includes(context.taskEnvironment!.AP_GRAPH_OUTPUT_DIR!), 'Resume must receive current approved output');
      assert.equal(continuationMessage, task.description, 'First and resumed transport share the fully prepared request');
      return getHarnessAdapter('codex')!.execute({ task, context });
    };
    getHarnessAdapter('kimi-code')!.execute = async () => { architecture++; return { success: true, executionTime: 1, output: 'TASK_GRAPH_ARCH_REVIEW {"approved":true,"note":"both approved deliveries retained"}' }; };
    for (let n = 0; n < 300; n++) {
      await runTaskGraphCycle();
      if ((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const abort = new AbortController(); abort.abort(); await startTaskGraphCoordinator(abort.signal);
    const final = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: b.id } });
    const failures = await prisma.taskGraphEvent.findMany({ where: { runId: run.id, kind: { in: ['architecture_failed', 'verification_failed', 'review_workspace_failed'] } }, select: { kind: true, payload: true } });
    assert(resumeCalls > 0, 'Fixture must actually use Resume');
    assert.match(resumedMessage, /受控冲突修复/, 'DEMAG replay: current stage missing from actual Resume input');
    const runErrors = await prisma.taskRun.findMany({ where: { taskId: { startsWith: 'task-graph-' } }, select: { status: true, error: true, summary: true } });
    assert.equal((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).status, 'completed', JSON.stringify({ failures, progress: executionProgress(final.dispatchMetadata), runErrors }));
    assert.equal(repairs, 1); assert.equal(successors, 1); assert.equal(architecture, 1); assert.equal(qualityReviews, agentOwned ? 2 : 0);
    assert.equal(executionProgress(final.dispatchMetadata)?.repairAttempts, 1);
    assert.equal(executionProgress(final.dispatchMetadata)?.platformAttempts, 1, 'Actual repair process exit uses the existing bounded restart budget');
    git(repository, 'merge-base', '--is-ancestor', advanced.commit, final.commit!);
    assert.equal(git(repository, 'show', `${final.commit}:contract.md`), 'base\nfirst\nsecond');
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'implementation_recovery_scheduled' } }), 0);
    console.log(completedBlocked ? 'Completed-but-blocked repair result is not replayed; fresh native Resume and artifact pass' : 'Legacy waiting conflict + advanced approved integration + SIGKILL during repair: automatic fresh artifact attempt, merged checks, independent architecture, acceptance and successor once; human resume 0');
  } finally { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); globalThis.fetch = fetch; await prisma.$disconnect(); await fs.rm(root, { recursive: true, force: true }); }
}
main().then(() => main(true)).then(() => main(false, true)).catch(error => { console.error(error); process.exitCode = 1; });
