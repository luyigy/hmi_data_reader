import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, releaseReadyNodes, claimNode, claimExecution } from '../src/lib/task-graph/store';
import { applyExecutionOutcome, executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { prepareTaskDeclaredRuntime } from '../src/lib/task-graph/runtime-continuity';
import { runtimeResourceDigest } from '../src/lib/task-graph/runtime-contract';
import { runSandboxedGraphCheck } from '../src/lib/task-graph/check-environment';
import { applyWorkflowPermissionSnapshot, buildWorkflowPermissionSnapshot } from '../src/lib/workflow-execution-policy';
import { executeViaLocalHarness } from '../src/lib/acpx/runner-harness';
import { getHarnessAdapter } from '../src/lib/harness';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from '../src/lib/acpx/permissions';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const originalCwd = process.cwd(), scratch = await mkdtemp(path.join(tmpdir(), 'runtime-pin-'));
  const oldValidation = process.env.TASK_GRAPH_VALIDATION_ROOT, oldRuntime = process.env.TASK_GRAPH_RUNTIME_ROOT, oldCodexHome = process.env.CODEX_HOME;
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(scratch, 'runtime'); process.env.CODEX_HOME = path.join(scratch, 'private-auth'); await mkdir(process.env.CODEX_HOME);
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(scratch, 'validation');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  let runId: string | undefined, parentId: string | undefined; const childIds: string[] = [];
  try {
    const platform = path.join(scratch, 'platform'), repo = path.join(scratch, 'repo'), weights = path.join(scratch, 'shared-weights');
    await mkdir(path.join(platform, 'config'), { recursive: true }); await mkdir(repo); await mkdir(weights);
    for (const directory of [platform, repo]) { git(directory, 'init', '-b', 'main'); git(directory, 'config', 'user.name', 'Test'); git(directory, 'config', 'user.email', 'test@example.test'); await writeFile(path.join(directory, 'source.txt'), 'source'); git(directory, 'add', '.'); git(directory, 'commit', '-m', 'fixture'); }
    await writeFile(path.join(weights, 'model.bin'), 'approved OCR bytes');
    const declaration = { version: 1, ocr: { weights: { path: weights, sha256: await runtimeResourceDigest(weights) }, requiredFiles: ['model.bin'] } };
    const registrationFile = path.join(platform, 'config/runtime-resources.json');
    const permissionFile = path.join(platform, 'config/runtime-environments.json');
    await writeFile(registrationFile, JSON.stringify({ [repo]: declaration }));
    await writeFile(permissionFile, JSON.stringify({ [repo]: [weights], [path.join(scratch, 'job')]: [weights] }));
    process.chdir(platform);
    const commit = git(repo, 'rev-parse', 'HEAD'), jobPath = path.join(scratch, 'job'); git(repo, 'worktree', 'add', '--detach', jobPath, commit);
    const parent = await prisma.task.create({ data: { name: 'Claim runtime pin' } }); parentId = parent.id;
    const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'test://runtime-pin', nodes: ['PIN', 'CAS', 'NONE', 'HEAD', 'WORKFLOW'].map(key => ({
      key, goal: key, dependsOn: [], acceptance: { mode: 'automatic', checks: ['runtime'] }, executions: [{ key: 'job', repository: repo, gitRef: 'refs/heads/main', baseCommit: commit, agentSelector: 'local:codex', instructions: key }] })) } }); runId = run.id;
    await releaseReadyNodes(run.id);
    const jobs = new Map<string, string>();
    const worker = await createGraphWriter();
    for (const key of ['PIN', 'CAS', 'NONE', 'HEAD', 'WORKFLOW']) {
      await claimNode(run.id, key, `claim-${key}`); const job = await claimExecution(run.id, key, 'job', `claim-${key}`); assert(job); jobs.set(key, job.id);
      const child = await prisma.task.create({ data: { id: `task-graph-${job.id}`, name: `runtime ${key}` } }); childIds.push(child.id);
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: `task-graph-${job.id}`, worktreePath: jobPath } });
      await applyExecutionOutcome({ executionId: job.id, claimToken: `claim-${key}`, expectedRevision: 0, outcomeId: 'candidate', outcome: { kind: 'checkpoint', phase: 'implement', workspaceBase: commit, candidateCommit: commit, worker } });
    }
    const prepare = async (key: string, workspace = jobPath, roots: string[] = []) => {
      const outputDirectory = path.join(scratch, `output-${key}-${Math.random().toString(16).slice(2)}`); await mkdir(outputDirectory);
      return prepareTaskDeclaredRuntime({ taskId: `task-graph-${jobs.get(key)}`, workspace, approvedReadOnlyRoots: roots, outputDirectory, writerNonce: worker.nonce });
    };
    const first = await prepare('PIN'); assert(first.identity); assert.equal(first.env.AP_GRAPH_OCR_MODEL_DIR, weights);
    const jobId = jobs.get('PIN'); assert(jobId);
    const before = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: jobId } });
    const pin = await prisma.taskGraphEvent.findFirstOrThrow({ where: { runId: run.id, kind: 'runtime_snapshot_pinned' } });
    await writeFile(registrationFile, JSON.stringify({ [repo]: { version: 1 } }));
    await writeFile(permissionFile, JSON.stringify({ [repo]: [weights, '/tmp'], [jobPath]: [weights, '/tmp'] }));
    const next = await prepare('PIN'); assert.equal(next.identity, first.identity); assert.equal(next.env.AP_GRAPH_OCR_MODEL_DIR, weights); assert(!next.readOnlyPaths.includes('/tmp'), 'Mutable registration and grants cannot widen a pinned claim');
    const nativeTask = await prisma.task.findUniqueOrThrow({ where: { id: `task-graph-${jobId}` } });
    const nativeRun = await prisma.taskRun.create({ data: { taskId: nativeTask.id, status: 'running', mode: 'acpx', controlMetadata: JSON.stringify({ graphWriter: worker }), participants: { create: { gatewayNameSnapshot: 'local', runner: 'codex', harnessType: 'codex', executionBackend: 'platform_local', role: 'implementer', status: 'running' } } }, include: { participants: true } });
    const adapter = getHarnessAdapter('codex'); assert(adapter); const originalExecute = adapter.execute;
    adapter.execute = async ({ context }) => { assert(!context.extraReadOnlyPaths?.includes('/tmp'), 'Native caller must not reread an expanded exact-workspace host grant after pin'); assert.equal(context.taskEnvironment?.AP_GRAPH_RUNTIME_IDENTITY, first.identity); return { success: true, output: 'pinned native caller', executionTime: 1 }; };
    try { await executeViaLocalHarness({ taskId: nativeTask.id, taskName: nativeTask.name, workingDirectory: jobPath, orchestrationMode: 'single', participants: [] }, nativeRun.id, nativeRun.participants[0].id, { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' }, {}, [], { transcript: '', latestUserMessage: null }); } finally { adapter.execute = originalExecute; }
    const checked = await runSandboxedGraphCheck(['node', '-e', 'const fs=require("fs");if(fs.readFileSync(process.env.AP_GRAPH_OCR_MODEL_DIR+"/model.bin","utf8")!=="approved OCR bytes")throw Error("weights");fs.writeFileSync(process.env.AP_GRAPH_OUTPUT_DIR+"/receipt.json","ok");console.log(process.env.AP_GRAPH_RUNTIME_IDENTITY)'], jobPath, { AP_GRAPH_SERVICE_TASK_ID: `task-graph-${jobId}`, AP_GRAPH_WRITER_NONCE: worker.nonce });
    assert.equal(checked.stdout.trim(), first.identity);
    const review = path.join(scratch, 'non-git-review'); await mkdir(review);
    const progress = executionProgress(before.dispatchMetadata); assert(progress);
    await prisma.taskGraphExecution.update({ where: { id: jobId }, data: { status: 'integrated', commit, dispatchMetadata: metadataWithProgress(before.dispatchMetadata, { ...progress, phase: 'acceptance', revision: progress.revision + 1 }) } });
    const reviewOut = path.join(scratch, 'review-out'); await mkdir(reviewOut);
    const acceptance = await prepareTaskDeclaredRuntime({ taskId: `task-graph-review-${before.nodeId}`, workspace: review, approvedReadOnlyRoots: [jobPath], outputDirectory: reviewOut });
    assert.equal(acceptance.identity, first.identity); assert.equal(acceptance.env.AP_GRAPH_OCR_MODEL_DIR, weights);
    const restricted = applyWorkflowPermissionSnapshot(DEFAULT_ACPX_PERMISSION_CONFIG, buildWorkflowPermissionSnapshot({ policy: { preset: 'workspace', extraReadOnlyPaths: [], extraWritableRoots: [] }, projectPath: review, source: 'restricted-test' }));
    await assert.rejects(prepareTaskDeclaredRuntime({ taskId: `task-graph-review-${before.nodeId}`, workspace: review, approvedReadOnlyRoots: [jobPath], outputDirectory: reviewOut, permissionConfig: restricted }), /超出已批准目录/);
    await writeFile(path.join(weights, 'model.bin'), 'mutated'); await assert.rejects(prepareTaskDeclaredRuntime({ taskId: `task-graph-review-${before.nodeId}`, workspace: review, approvedReadOnlyRoots: [jobPath], outputDirectory: reviewOut }), /SHA256/); await writeFile(path.join(weights, 'model.bin'), 'approved OCR bytes');
    await mkdir(path.join(jobPath, '.agent-platform')); await writeFile(path.join(jobPath, '.agent-platform/runtime.json'), '{invalid');
    await assert.rejects(prepareTaskDeclaredRuntime({ taskId: `task-graph-review-${before.nodeId}`, workspace: review, approvedReadOnlyRoots: [jobPath], outputDirectory: reviewOut }), /纳入 Git|运行能力/);
    await rm(path.join(jobPath, '.agent-platform'), { recursive: true });
    const promoted = path.join(scratch, 'new-candidate'); git(repo, 'worktree', 'add', '--detach', promoted, commit); await writeFile(path.join(promoted, 'source.txt'), 'new candidate code'); git(promoted, 'add', 'source.txt'); git(promoted, 'commit', '-m', 'Candidate code advances');
    const promotedCommit = git(promoted, 'rev-parse', 'HEAD'), integrated = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: jobId } }); const integratedProgress = executionProgress(integrated.dispatchMetadata); assert(integratedProgress);
    await prisma.taskGraphExecution.update({ where: { id: jobId }, data: { commit: promotedCommit, worktreePath: promoted, dispatchMetadata: metadataWithProgress(integrated.dispatchMetadata, { ...integratedProgress, candidateCommit: promotedCommit, revision: integratedProgress.revision + 1 }) } });
    assert.equal((await prepareTaskDeclaredRuntime({ taskId: `task-graph-review-${before.nodeId}`, workspace: review, approvedReadOnlyRoots: [promoted], outputDirectory: reviewOut })).identity, first.identity, 'Candidate code may advance while the declaration and resource identity remain pinned');
    await writeFile(permissionFile, JSON.stringify({ [repo]: [weights], [jobPath]: [weights] }));
    await writeFile(registrationFile, '{}'); const none = await prepare('NONE'); assert.equal(none.identity, ''); assert(none.readOnlyPaths.includes(weights), 'No-declaration legacy readonly grant remains available');
    await writeFile(registrationFile, JSON.stringify({ [repo]: declaration })); await writeFile(permissionFile, JSON.stringify({ [repo]: [weights, '/tmp'], [jobPath]: [weights, '/tmp'] }));
    assert.equal((await prepare('NONE')).identity, '', 'A pinned absence cannot silently adopt a new host registration');
    const noneTaskId = `task-graph-${jobs.get('NONE')}`;
    const noneRun = await prisma.taskRun.create({ data: { taskId: noneTaskId, status: 'running', mode: 'acpx', controlMetadata: JSON.stringify({ graphWriter: worker }), participants: { create: { gatewayNameSnapshot: 'local', runner: 'codex', harnessType: 'codex', executionBackend: 'platform_local', role: 'implementer', status: 'running' } } }, include: { participants: true } });
    adapter.execute = async ({ context }) => { assert(context.extraReadOnlyPaths?.includes(weights), 'Native legacy grant is retained without declaration'); assert(!context.extraReadOnlyPaths?.includes('/tmp'), 'Null declaration pin still freezes legacy grants against expansion'); assert.equal(context.taskEnvironment?.AP_GRAPH_RUNTIME_IDENTITY, undefined); return { success: true, output: 'legacy readonly pin', executionTime: 1 }; };
    try { await executeViaLocalHarness({ taskId: noneTaskId, taskName: 'legacy runtime caller', workingDirectory: jobPath, orchestrationMode: 'single', participants: [] }, noneRun.id, noneRun.participants[0].id, { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' }, {}, [], { transcript: '', latestUserMessage: null }); } finally { adapter.execute = originalExecute; }
    const workflowPath = path.join(scratch, 'workflow-candidate'); git(repo, 'worktree', 'add', '--detach', workflowPath, commit); await mkdir(path.join(workflowPath, '.agent-platform')); await writeFile(path.join(workflowPath, '.agent-platform/runtime.json'), JSON.stringify(declaration)); git(workflowPath, 'add', '.'); git(workflowPath, 'commit', '-m', 'Workflow-approved project declaration');
    const workflowCommit = git(workflowPath, 'rev-parse', 'HEAD'), workflowId = jobs.get('WORKFLOW'); assert(workflowId);
    const workflowJob = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: workflowId } }); const workflowProgress = executionProgress(workflowJob.dispatchMetadata); assert(workflowProgress);
    await prisma.taskGraphExecution.update({ where: { id: workflowId }, data: { worktreePath: workflowPath, dispatchMetadata: metadataWithProgress(workflowJob.dispatchMetadata, { ...workflowProgress, candidateCommit: workflowCommit }) } });
    const allowed = applyWorkflowPermissionSnapshot(DEFAULT_ACPX_PERMISSION_CONFIG, buildWorkflowPermissionSnapshot({ policy: { preset: 'workspace', extraReadOnlyPaths: [weights], extraWritableRoots: [] }, projectPath: workflowPath, source: 'approved-runtime-test' }));
    const workflowOutput = path.join(scratch, 'workflow-output'); await mkdir(workflowOutput);
    const workflowRuntime = await prepareTaskDeclaredRuntime({ taskId: `task-graph-${workflowId}`, workspace: workflowPath, approvedReadOnlyRoots: [weights], outputDirectory: workflowOutput, permissionConfig: allowed });
    assert(workflowRuntime.identity);
    await prisma.taskGraphExecution.update({ where: { id: workflowId }, data: { status: 'integrated', commit: workflowCommit, dispatchMetadata: metadataWithProgress(workflowJob.dispatchMetadata, { ...workflowProgress, phase: 'acceptance', candidateCommit: workflowCommit, revision: workflowProgress.revision + 1 }) } });
    assert.equal((await prepareTaskDeclaredRuntime({ taskId: `task-graph-review-${workflowJob.nodeId}`, workspace: review, approvedReadOnlyRoots: [workflowPath], outputDirectory: workflowOutput })).identity, workflowRuntime.identity, 'An original immutable workflow grant remains available to later stages without consulting mutable host policy');
    const require = createRequire(__filename), preflight: typeof import('../src/lib/task-graph/runtime-preflight') = require('../src/lib/task-graph/runtime-preflight');
    const original = preflight.prepareDeclaredRuntime;
    preflight.prepareDeclaredRuntime = async args => { const result = await original(args); const row = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: jobs.get('CAS')! } }); const state = executionProgress(row.dispatchMetadata); assert(state); await prisma.taskGraphExecution.update({ where: { id: row.id }, data: { dispatchMetadata: metadataWithProgress(row.dispatchMetadata, { ...state, revision: state.revision + 1 }) } }); return result; };
    try { await assert.rejects(prepare('CAS'), /revision 已改变/); } finally { preflight.prepareDeclaredRuntime = original; }
    preflight.prepareDeclaredRuntime = async args => { const result = await original(args); await writeFile(path.join(jobPath, 'source.txt'), 'new unbound HEAD'); git(jobPath, 'add', 'source.txt'); git(jobPath, 'commit', '-m', 'concurrent source advance'); return result; };
    try { await assert.rejects(prepare('HEAD'), /源码目录或提交改变/); } finally { preflight.prepareDeclaredRuntime = original; }
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'runtime_snapshot_pinned' } }), 3, 'CAS failure cannot publish a stale runtime pin');
    assert.deepEqual((await prisma.taskGraphEvent.findUniqueOrThrow({ where: { id: pin.id } })).payload, pin.payload, 'Claim pin remains append-only');
    console.log('Native preparation, real platform sandbox check and non-Git acceptance share a claim pin; host changes cannot widen, resource/config mutation and stale CAS reject, explicit workflow restriction wins, pinned absence remains absent');
  } finally {
    process.chdir(originalCwd); if (oldRuntime === undefined) delete process.env.TASK_GRAPH_RUNTIME_ROOT; else process.env.TASK_GRAPH_RUNTIME_ROOT = oldRuntime; if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome; if (oldValidation === undefined) delete process.env.TASK_GRAPH_VALIDATION_ROOT; else process.env.TASK_GRAPH_VALIDATION_ROOT = oldValidation;
    if (runId) await prisma.taskGraphRun.delete({ where: { id: runId } }); await prisma.task.deleteMany({ where: { id: { in: childIds } } }); if (parentId) await prisma.task.delete({ where: { id: parentId } }); await prisma.$disconnect(); await rm(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
