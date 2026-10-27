import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, releaseReadyNodes, claimNode, claimExecution, completeExecution, markNodeIntegrationsReady, submitNodeVerification } from '../src/lib/task-graph/store';
import { applyExecutionOutcome, executionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { prepareTaskDeclaredRuntime } from '../src/lib/task-graph/runtime-continuity';
import { platformRepository } from '../src/lib/platform-repository';
import { parseRuntimeDeclaration, type RuntimeDeclaration, runtimeResourceDigest } from '../src/lib/task-graph/runtime-contract';
import { runSandboxedGraphCheck } from '../src/lib/task-graph/check-environment';
import { inheritProjectCapabilityScopes } from '../src/lib/project-capabilities/proposal';
import { withTaskProjectCapabilities } from '../src/lib/project-capabilities/task-runtime';
import { migrateLegacyProjectScope } from '../src/lib/project-capabilities/legacy-scope';
import { projectCapabilityContext } from '../src/lib/project-capabilities/context';
import { applyWorkflowPermissionSnapshot, buildWorkflowPermissionSnapshot } from '../src/lib/workflow-execution-policy';
import { DEFAULT_ACPX_PERMISSION_CONFIG } from '../src/lib/acpx/permissions';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'capability-c02-'));
  let parentId: string | undefined; const taskIds: string[] = [];
  const original = { AP_PROJECT_REPOSITORY: process.env.AP_PROJECT_REPOSITORY, HOME: process.env.HOME, FEISHU_APP_ID: process.env.FEISHU_APP_ID, TASK_GRAPH_VALIDATION_ROOT: process.env.TASK_GRAPH_VALIDATION_ROOT };
  delete process.env.AP_PROJECT_REPOSITORY; // The outer test sandbox is not a fixture project.
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  process.env.HOME = path.join(scratch, 'home'); process.env.FEISHU_APP_ID = 'cli_test'; process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(scratch, 'outputs');
  await fs.mkdir(path.join(process.env.HOME, '.agent-platform'), { recursive: true });
  try {
    const user = await prisma.user.create({ data: { username: 'capability-c02-' + Date.now(), passwordHash: 'fixture' } });
    const weights = path.join(scratch, 'weights'); await fs.mkdir(weights); await fs.writeFile(path.join(weights, 'model.bin'), 'shared versioned OCR');
    const runtime: RuntimeDeclaration = { version: 1, ocr: { weights: { kind: 'path', path: weights, sha256: await runtimeResourceDigest(weights) }, requiredFiles: ['model.bin'] } };
    const toolRoots = [weights];
    if (process.env.AP_CAPABILITY_BROWSER_PROBE === '1') {
      const host = JSON.parse(await fs.readFile(path.join(platformRepository(), 'config/runtime-resources.json'), 'utf8'));
      const registered = Object.values(host).map(parseRuntimeDeclaration).find(item => item.browser); assert(registered?.browser);
      runtime.browser = registered.browser;
      for (const resource of [runtime.browser.module, runtime.browser.executable]) { assert.equal(resource.kind, 'path'); if (resource.kind === 'path') toolRoots.push((await fs.stat(resource.path)).isDirectory() ? resource.path : path.dirname(resource.path)); }
    }
    const projects = [];
    for (const key of ['reader', 'mold']) {
      const repository = path.join(scratch, key), images = path.join(scratch, key + '-images'); await fs.mkdir(repository); await fs.mkdir(images);
      git(repository, 'init', '-b', 'main'); git(repository, 'config', 'user.name', 'test'); git(repository, 'config', 'user.email', 'test@example.test');
      await fs.writeFile(path.join(repository, '.gitignore'), '.venv/\n');
      await fs.writeFile(path.join(repository, 'source.txt'), key); git(repository, 'add', '.'); git(repository, 'commit', '-m', 'fixture');
      const python = path.join(repository, '.venv'); await fs.mkdir(path.join(python, 'bin'), { recursive: true });
      await fs.symlink('/usr/bin/python3', path.join(python, 'bin/python')); await fs.writeFile(path.join(python, 'pyvenv.cfg'), 'home = /usr/bin\ninclude-system-site-packages = false\n');
      projects.push({ python, repository, images, key, commit: git(repository, 'rev-parse', 'HEAD') });
    }
    const policy = { version: 1, projects: projects.map(project => ({ repository: project.repository, appId: 'cli_test', principals: ['platform:' + user.id], readOnlyRoots: [...toolRoots, project.images, project.python],
      runtime: structuredClone(runtime), sources: [{ key: 'photos', baseToken: 'base' + project.key, tableId: 'tbl' + project.key, searchField: 'Brand', imageFields: ['Photo'] }] })) };
    const policyFile = path.join(process.env.HOME, '.agent-platform/project-capabilities.json'); await fs.writeFile(policyFile, JSON.stringify(policy));
    const parent = await prisma.task.create({ data: { name: 'C02 parallel cross repository test', ownerUserId: user.id } }); parentId = parent.id;
    const definition = await inheritProjectCapabilityScopes({ specRef: 'test://c02', nodes: [...projects.map(project => ({ key: project.key, goal: project.key, dependsOn: [],
      acceptance: { mode: 'automatic' as const, checks: ['isolated check'] }, executions: [{ key: project.key, repository: project.repository, gitRef: 'refs/heads/main', baseCommit: project.commit, agentSelector: 'local:codex', instructions: 'test' }] })),
      { key: 'after', goal: 'after both', dependsOn: ['reader', 'mold'], acceptance: { mode: 'automatic' as const, checks: ['isolated check'] }, executions: [{ key: 'after', repository: projects[0].repository, gitRef: 'refs/heads/main', baseCommit: projects[0].commit, agentSelector: 'local:codex', instructions: 'next' }] }] });
    const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition });
    assert.deepEqual((await releaseReadyNodes(graph.id)).sort(), ['mold', 'reader']);
    const worker = await createGraphWriter();
    const jobs = await Promise.all(projects.map(async project => {
      await claimNode(graph.id, project.key, 'claim-' + project.key); const job = await claimExecution(graph.id, project.key, project.key, 'claim-' + project.key); assert(job);
      const workspace = path.join(scratch, 'worktree-' + project.key); git(project.repository, 'worktree', 'add', '--detach', workspace, project.commit);
      const child = await prisma.task.create({ data: { id: 'task-graph-' + job.id, name: project.key, workingDirectory: workspace } });
      taskIds.push(child.id);
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: child.id, worktreePath: workspace, worktreeBranch: 'fixture-' + project.key } });
      await applyExecutionOutcome({ executionId: job.id, claimToken: 'claim-' + project.key, expectedRevision: 0, outcomeId: 'candidate', outcome: { kind: 'checkpoint', phase: 'implement', candidateCommit: project.commit, worker } });
      const run = await prisma.taskRun.create({ data: { taskId: child.id, status: 'running' } });
      const output = path.join(scratch, 'prepare-' + project.key); await fs.mkdir(output);
      const prepared = await prepareTaskDeclaredRuntime({ taskId: child.id, taskRunId: run.id, workspace, approvedReadOnlyRoots: [], outputDirectory: output });
      assert.equal(prepared.env.AP_GRAPH_OCR_MODEL_DIR, weights); if (runtime.browser) assert(prepared.receipt?.browserVersion); assert(prepared.readOnlyPaths.includes(project.images));
      return { ...project, ...job, commit: project.commit, workspace, child, run, prepared };
    }));
    assert.equal(jobs[0].prepared.receipt?.identity, jobs[1].prepared.receipt?.identity, 'Both projects resolve the same fixed OCR/browser identity');
    assert.notEqual(jobs[0].prepared.identity, jobs[1].prepared.identity, 'Distinct Python environments have distinct pinned identities');
    await Promise.all(jobs.map(job => withTaskProjectCapabilities({ taskId: job.child.id, taskRunId: job.run.id, workspace: job.workspace }, async access => {
      assert(access.readOnlyPaths.includes(job.images)); assert(!access.readOnlyPaths.includes(jobs.find(other => other.key !== job.key)!.images));
      const client = path.resolve('scripts/project-capability-client.cjs');
      const env = { NODE_ENV: 'test' as const, PATH: process.env.PATH, HOME: '/tmp', ...access.env, AP_TASK_SANDBOX: '1', AP_SANDBOX_MODEL_ACCESS: '0' };
      const wrapped = wrapWithBubblewrap({ command: process.execPath, commandArgs: [client, 'sources'], cwd: job.workspace, workspaceRoot: job.workspace, sandboxMode: 'read-only', networkAccess: 'restricted', env, readOnlyPaths: access.readOnlyPaths });
      const result = JSON.parse((await promisify(execFile)(wrapped.command, wrapped.args, { env })).stdout); assert.equal(result.sources[0].key, 'photos');
    })));
    const checked = await runSandboxedGraphCheck(['node', '-e', 'const fs=require("fs");if(!process.env.VIRTUAL_ENV||!process.env.VIRTUAL_ENV.endsWith("mold/.venv"))throw Error("python identity");if(!process.env.AP_PROJECT_CAPABILITY_SOCKET)throw Error("missing broker");if(fs.readFileSync(process.env.AP_GRAPH_OCR_MODEL_DIR+"/model.bin","utf8")!=="shared versioned OCR")throw Error("tool");let denied=false;try{fs.writeFileSync("source.txt","bad")}catch(e){denied=true}if(!denied)throw Error("writable source");console.log(process.env.AP_GRAPH_RUNTIME_IDENTITY)'], jobs[1].workspace,
      { AP_GRAPH_SERVICE_TASK_ID: jobs[1].child.id, AP_GRAPH_WRITER_NONCE: worker.nonce });
    assert.equal(checked.stdout.trim(), jobs[1].prepared.identity);
    const checkpoint = async (job: typeof jobs[number], phase: 'implement' | 'integrate') => {
      const latest = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } }); const progress = executionProgress(latest.dispatchMetadata); assert(progress);
      return applyExecutionOutcome({ executionId: job.id, claimToken: 'claim-' + job.key, expectedRevision: progress.revision, outcomeId: phase + '-checkpoint', outcome: { kind: 'checkpoint', phase } });
    };
    const finish = async (job: typeof jobs[number]) => {
      await checkpoint(job, 'integrate'); await completeExecution({ runId: graph.id, nodeKey: job.key, executionKey: job.key, claimToken: 'claim-' + job.key, commit: job.commit, evidence: { checked: true } });
      await markNodeIntegrationsReady(graph.id, job.key);
      await submitNodeVerification({ runId: graph.id, nodeKey: job.key, actorId: 'system', evidence: { summary: 'fixture isolated evidence', checks: [{ name: 'isolated check', passed: true, evidence: 'sandbox source stayed readonly and tool identity matched' }] } });
    };
    const reader = jobs[0], mold = jobs[1];
    const pythonConfig = path.join(reader.python, 'pyvenv.cfg'), originalPython = await fs.readFile(pythonConfig, 'utf8');
    await fs.writeFile(pythonConfig, originalPython + 'changed = true\n');
    const changedOutput = path.join(scratch, 'python-change'); await fs.mkdir(changedOutput);
    await assert.rejects(prepareTaskDeclaredRuntime({ taskId: reader.child.id, workspace: reader.workspace, approvedReadOnlyRoots: [], outputDirectory: changedOutput }), /Python/);
    await fs.writeFile(pythonConfig, originalPython);

    const readerProgress = executionProgress((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: reader.id } })).dispatchMetadata); assert(readerProgress);
    await applyExecutionOutcome({ executionId: reader.id, claimToken: 'claim-reader', expectedRevision: readerProgress.revision, outcomeId: 'human-question', outcome: { kind: 'waiting_for_user', note: 'fixture question' } });
    await finish(mold); assert.deepEqual(await releaseReadyNodes(graph.id), []);
    assert.equal((await prisma.taskGraphNode.findUniqueOrThrow({ where: { id: mold.nodeId } })).status, 'passed', 'Independent Mold advances while Reader waits for its user');
    // Restore only the scratch fixture to exercise the existing downstream release contract.
    const paused = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: reader.id } }); const pausedProgress = executionProgress(paused.dispatchMetadata); assert(pausedProgress);
    await prisma.taskGraphExecution.update({ where: { id: reader.id }, data: { status: 'claimed', dispatchMetadata: metadataWithProgress(paused.dispatchMetadata, { ...pausedProgress, state: 'active' }) } });
    await prisma.taskGraphNode.update({ where: { id: reader.nodeId }, data: { status: 'claimed' } });
    await finish(reader); assert.deepEqual(await releaseReadyNodes(graph.id), ['after']);
    const review = path.join(scratch, 'non-git-review'); await fs.mkdir(review); const reviewOutput = path.join(scratch, 'review-output'); await fs.mkdir(reviewOutput);
    const accepted = await prepareTaskDeclaredRuntime({ taskId: 'task-graph-review-' + reader.nodeId, workspace: review, approvedReadOnlyRoots: [reader.workspace], outputDirectory: reviewOutput });
    assert.equal(accepted.identity, reader.prepared.identity, 'Non-Git acceptance retains original tools');
    const limited = applyWorkflowPermissionSnapshot(DEFAULT_ACPX_PERMISSION_CONFIG, buildWorkflowPermissionSnapshot({ policy: { preset: 'workspace', extraReadOnlyPaths: [] }, projectPath: review, source: 'test' }));
    await assert.rejects(prepareTaskDeclaredRuntime({ taskId: 'task-graph-review-' + reader.nodeId, workspace: review, approvedReadOnlyRoots: [reader.workspace], outputDirectory: reviewOutput, permissionConfig: limited }), /显式文件权限/);
    process.env.FEISHU_APP_ID = 'cli_other';
    await assert.rejects(projectCapabilityContext({ taskId: reader.child.id, workspace: reader.workspace, taskRunId: reader.run.id }), /未获/);
    process.env.FEISHU_APP_ID = 'cli_test';
    const before = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: reader.id } });
    await fs.writeFile(policyFile, JSON.stringify({ ...policy, projects: [] }));
    await assert.rejects(prepareTaskDeclaredRuntime({ taskId: 'task-graph-review-' + reader.nodeId, workspace: review, approvedReadOnlyRoots: [reader.workspace], outputDirectory: reviewOutput }), /授权变化|授权已撤销/);
    assert.deepEqual(await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: reader.id } }), before, 'Revocation preserves candidate, budgets and writer');
    await fs.writeFile(policyFile, JSON.stringify(policy));
    // New approved route: heterogeneous tools and multiple executions of one repository.
    const otherWeights = path.join(scratch, 'mold-weights'); await fs.mkdir(otherWeights); await fs.writeFile(path.join(otherWeights, 'model.bin'), 'different mold OCR');
    const changed = structuredClone(policy); assert(changed.projects[1].runtime.ocr); changed.projects[1].runtime.ocr.weights = { kind: 'path', path: otherWeights, sha256: await runtimeResourceDigest(otherWeights) };
    changed.projects[1].readOnlyRoots.push(otherWeights); await fs.writeFile(policyFile, JSON.stringify(changed));
    const dualDefinition = await inheritProjectCapabilityScopes({ specRef: 'test://c02-multi', nodes: [{ key: 'both', goal: 'multi project acceptance', dependsOn: [], acceptance: { mode: 'automatic', checks: ['tools'] },
      executions: projects.map(project => ({ key: project.key, repository: project.repository, gitRef: 'refs/heads/main', baseCommit: project.commit, agentSelector: 'local:codex', instructions: 'test' })) },
      { key: 'same', goal: 'independent scopes within same repository', dependsOn: [], acceptance: { mode: 'automatic', checks: ['tools'] },
        executions: ['wide', 'narrow'].map(key => ({ key, repository: reader.repository, gitRef: 'refs/heads/main', baseCommit: reader.commit, agentSelector: 'local:codex', instructions: 'test' })) }] });
    const narrow = dualDefinition.nodes[1].executions[1]; assert(narrow.capabilities); narrow.capabilities.sources = [];
    const dual = await createTaskGraphRun({ parentTaskId: parent.id, version: 2, requestKey: parent.id + '-multi', definition: dualDefinition }); await releaseReadyNodes(dual.id);
    let bothId = '', sameId = '';
    for (const nodeKey of ['both', 'same']) {
      const node = await claimNode(dual.id, nodeKey, 'multi-' + nodeKey); assert(node);
      if (nodeKey === 'both') bothId = node.id; else sameId = node.id;
      for (const spec of dualDefinition.nodes.find(item => item.key === nodeKey)!.executions) {
        const job = await claimExecution(dual.id, nodeKey, spec.key, 'multi-' + nodeKey); assert(job);
        const project = jobs.find(item => item.repository === spec.repository); assert(project);
        await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', commit: project.commit, worktreePath: project.workspace,
          dispatchMetadata: metadataWithProgress(job.dispatchMetadata, { version: 1, revision: 1, phase: 'acceptance', state: 'active', candidateCommit: project.commit, worker, workerReleasedAt: new Date().toISOString(), repairAttempts: 0, formatAttempts: 0, platformAttempts: 0, integrationAttempts: 0 }) } });
      }
    }
    const mixed = await prepareTaskDeclaredRuntime({ taskId: 'task-graph-review-' + bothId, workspace: review, approvedReadOnlyRoots: jobs.map(job => job.workspace), outputDirectory: reviewOutput });
    const toolsets = JSON.parse(mixed.env.AP_PROJECT_TOOL_RUNTIMES_JSON); assert.equal(toolsets.length, 2); assert.equal(mixed.env.AP_GRAPH_OCR_MODEL_DIR, undefined);
    assert.equal(toolsets.find((item: { key: string }) => item.key === 'reader').env.AP_GRAPH_OCR_MODEL_DIR, weights);
    assert.equal(toolsets.find((item: { key: string }) => item.key === 'mold').env.AP_GRAPH_OCR_MODEL_DIR, otherWeights);
    for (const [nodeId, expected] of [[bothId, ['mold/photos', 'reader/photos']], [sameId, ['wide/photos']]] satisfies [string, string[]][]) {
      const task = await prisma.task.create({ data: { id: 'task-graph-review-' + nodeId, name: 'multi review', workingDirectory: review } });
      taskIds.push(task.id);
      const run = await prisma.taskRun.create({ data: { taskId: task.id, status: 'running', controlMetadata: JSON.stringify({ graphReview: { runId: dual.id, nodeId } }) } });
      await withTaskProjectCapabilities({ taskId: task.id, taskRunId: run.id, workspace: review }, async access => {
        const stage = await prepareTaskDeclaredRuntime({ taskId: task.id, taskRunId: run.id, workspace: review, approvedReadOnlyRoots: jobs.map(job => job.workspace), outputDirectory: reviewOutput });
        const env = { NODE_ENV: 'test' as const, PATH: process.env.PATH, HOME: '/tmp', AP_TASK_SANDBOX: '1', AP_SANDBOX_MODEL_ACCESS: '0', ...stage.env, ...access.env };
        const wrapped = wrapWithBubblewrap({ command: process.execPath, commandArgs: [path.resolve('scripts/project-capability-client.cjs'), 'sources'], cwd: review, workspaceRoot: review, sandboxMode: 'read-only', networkAccess: 'restricted', env, readOnlyPaths: access.readOnlyPaths });
        const result = JSON.parse((await promisify(execFile)(wrapped.command, wrapped.args, { env })).stdout); assert.deepEqual(result.sources.map((item: { key: string }) => item.key).sort(), expected);
        if (nodeId === sameId) {
          const denied = wrapWithBubblewrap({ command: process.execPath, commandArgs: [path.resolve('scripts/project-capability-client.cjs'), 'query', 'narrow/photos', 'brand'], cwd: review, workspaceRoot: review, sandboxMode: 'read-only', networkAccess: 'restricted', env, readOnlyPaths: access.readOnlyPaths });
          await assert.rejects(promisify(execFile)(denied.command, denied.args, { env }), 'Narrow execution cannot query wide execution sources');
        }
      });
    }
    await fs.writeFile(policyFile, JSON.stringify(policy));
    const legacy = await createTaskGraphRun({ parentTaskId: parent.id, version: 3, requestKey: parent.id + '-legacy', definition: { specRef: 'test://legacy', nodes: [{ key: 'legacy', goal: 'preserve old candidate', dependsOn: [], acceptance: { mode: 'automatic', checks: ['tools'] },
      executions: [{ key: 'legacy', repository: reader.repository, gitRef: 'refs/heads/main', baseCommit: reader.commit, agentSelector: 'local:codex', instructions: 'old route has no capability scope' }] }] } });
    await releaseReadyNodes(legacy.id); await claimNode(legacy.id, 'legacy', 'legacy-claim');
    const legacyJob = await claimExecution(legacy.id, 'legacy', 'legacy', 'legacy-claim'); assert(legacyJob);
    const legacyTask = await prisma.task.create({ data: { id: 'task-graph-' + legacyJob.id, name: 'legacy', workingDirectory: reader.workspace } });
    taskIds.push(legacyTask.id);
    await prisma.taskGraphExecution.update({ where: { id: legacyJob.id }, data: { childTaskId: legacyTask.id, worktreePath: reader.workspace } });
    await applyExecutionOutcome({ executionId: legacyJob.id, claimToken: 'legacy-claim', expectedRevision: 0, outcomeId: 'old candidate', outcome: { kind: 'checkpoint', phase: 'implement', candidateCommit: reader.commit, worker } });
    const preview = await migrateLegacyProjectScope({ executionId: legacyJob.id }); assert.equal(preview.applied, false); assert.equal(preview.writer.kind, 'alive');
    await assert.rejects(migrateLegacyProjectScope({ executionId: legacyJob.id, apply: true, expectedPolicyHash: preview.policyHash }), /退出/);
    const active = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: legacyJob.id } }); const state = executionProgress(active.dispatchMetadata); assert(state);
    await prisma.taskGraphExecution.update({ where: { id: legacyJob.id }, data: { dispatchMetadata: metadataWithProgress(active.dispatchMetadata, { ...state, workerReleasedAt: new Date().toISOString() }) } });
    const preserved = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: legacyJob.id } });
    assert.equal((await migrateLegacyProjectScope({ executionId: legacyJob.id, apply: true, expectedPolicyHash: preview.policyHash })).applied, true);
    assert.equal((await migrateLegacyProjectScope({ executionId: legacyJob.id, apply: true, expectedPolicyHash: preview.policyHash })).applied, true);
    assert(await projectCapabilityContext({ taskId: legacyTask.id, workspace: reader.workspace }));
    assert.deepEqual(await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: legacyJob.id } }), preserved, 'Scope migration does not reset attempts, phase, candidate or writer');
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: legacy.id, kind: 'project_capability_scope_approved' } }), 1, 'Explicit host approval is append-only and idempotent');
    const outsider = await prisma.user.create({ data: { username: 'other-c02-' + Date.now(), passwordHash: 'fixture' } }); await prisma.task.update({ where: { id: parent.id }, data: { ownerUserId: outsider.id } });
    await assert.rejects(projectCapabilityContext({ taskId: reader.child.id, workspace: reader.workspace, taskRunId: reader.run.id }), /未获/);
    console.log('C02: two Git worktrees share fixed project tools; real checks see broker and readonly code; Mold advances while Reader waits; successor releases after evidence; non-Git acceptance retains tools; explicit restrictions, revocation and unauthorized user deny without changing candidates.');
  } finally {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (parentId) { await prisma.taskGraphRun.deleteMany({ where: { parentTaskId: parentId } }); await prisma.task.deleteMany({ where: { id: { in: [...taskIds, parentId] } } }); }
    await prisma.$disconnect(); await fs.rm(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
