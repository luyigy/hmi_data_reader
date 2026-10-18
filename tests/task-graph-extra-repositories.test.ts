import { createRequire } from 'node:module';
import { executeAcpxTaskRun } from '../src/lib/acpx/runner';
import { getHarnessAdapter } from '../src/lib/harness';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, claimNode, releaseReadyNodes } from '../src/lib/task-graph/store';
import { graphInputsForTask, prepareUpstreamInputs } from '../src/lib/task-graph/upstream-inputs';
import { initialExecutionProgress, metadataWithProgress } from '../src/lib/task-graph/execution-progress';
import { prepareExtraRepositories } from '../src/lib/task-graph/extra-repositories';
import { formatGraphProposal } from '../src/lib/task-graph/proposal-card';
import { validateTaskGraphDefinition, taskGraphSnapshotHash, type GraphDefinition } from '../src/lib/task-graph/domain';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';
import { runGraphCheck } from '../src/lib/task-graph/check-runner';
import { runSandboxedGraphCheck } from '../src/lib/task-graph/check-environment';
import { cleanupCompletedNodeWorkspaces } from '../src/lib/task-graph/completed-workspaces';

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'extra-repos-'));
  process.env.TASK_GRAPH_RUNTIME_ROOT = path.join(root, 'runtime');
  process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
  function repo(name: string) {
    const directory = path.join(root, name); mkdirSync(directory);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
    writeFileSync(path.join(directory, 'value'), name); git('add', '.'); git('commit', '-m', 'base');
    return { directory, commit: git('rev-parse', 'HEAD') };
  }
  const main = repo('main'), extra = repo('project-TMP'), hidden = repo('hidden');
  const task = await prisma.task.create({ data: { name: 'extra repo fixture' } });
  const definition: GraphDefinition = { specRef: 'test://extra', nodes: [
    { key: 'A', goal: 'dependency', dependsOn: [], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'repo', repository: extra.directory, gitRef: 'refs/heads/main', baseCommit: extra.commit, instructions: 'extra', agentSelector: 'local:codex' }] },
    { key: 'B', goal: 'consume', dependsOn: ['A'], extraRepositories: [{ repository: extra.directory, access: 'write' }], executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] }, executions: [{ key: 'repo', repository: main.directory, gitRef: 'refs/heads/main', baseCommit: main.commit, instructions: 'main', agentSelector: 'local:codex' }] },
  ] };
  const run = await createTaskGraphRun({ parentTaskId: task.id, version: 1, requestKey: task.id, definition });
  try {
    await prisma.taskGraphNode.update({ where: { runId_key: { runId: run.id, key: 'A' } }, data: { status: 'delivered_unverified' } });
    await prisma.taskGraphExecution.updateMany({ where: { node: { runId: run.id, key: 'A' } }, data: { status: 'integrated', commit: extra.commit } });
    await releaseReadyNodes(run.id); await claimNode(run.id, 'B', 'fixture');
    const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'B' } } });
    const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } });
    const child = await prisma.task.create({ data: { id: 'task-graph-' + job.id, name: 'B' } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: child.id, claimToken: 'attempt' } });
    const managed = repo('.agent-platform-task-graph-worktrees');
    await assert.rejects(prepareExtraRepositories([{ repository: managed.directory, access: 'read' }]), /平台临时工作区/);
    symlinkSync(hidden.directory, path.join(extra.directory, 'external-link'));
    await assert.rejects(prepareExtraRepositories([{ repository: extra.directory, access: 'read' }]), /外部链接/);
    unlinkSync(path.join(extra.directory, 'external-link'));
    writeFileSync(path.join(extra.directory, 'temporary.tmp'), 'keep original file');
    const pinned = await prepareUpstreamInputs(job.id);
    assert.equal(pinned.manifest.inputs.length, 1, 'Extra repo permission preserves the predecessor delivery binding');
    assert.equal(pinned.manifest.inputs[0].commit, extra.commit);
    const inputs = await graphInputsForTask(child.id); assert.deepEqual(inputs.writablePaths, [extra.directory]);
    assert.equal(JSON.parse(inputs.env.TASK_GRAPH_EXTRA_REPOS_JSON)[0].repository, extra.directory);
    assert.match(formatGraphProposal(definition), /附加仓库授权/); assert.match(formatGraphProposal(definition), /读写/);
    const writer = repo('writer');
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'passed' } });
    const gateRun = await createTaskGraphRun({ parentTaskId: task.id, version: 2, requestKey: task.id + '-gates', definition: { specRef: 'test://gates', nodes: [
      { ...definition.nodes[1], key: 'R1', dependsOn: [], extraRepositories: [{ repository: extra.directory, access: 'read' }] },
      { ...definition.nodes[1], key: 'R2', dependsOn: [], executions: [{ ...definition.nodes[1].executions[0], repository: hidden.directory, baseCommit: hidden.commit }], extraRepositories: [{ repository: extra.directory, access: 'read' }] },
      { ...definition.nodes[1], key: 'W', dependsOn: [], executions: [{ ...definition.nodes[1].executions[0], repository: writer.directory, baseCommit: writer.commit }] },
    ] } });
    try {
      await releaseReadyNodes(gateRun.id);
      assert.ok(await claimNode(gateRun.id, 'R1', 'r1')); assert.ok(await claimNode(gateRun.id, 'R2', 'r2'));
      assert.equal(await claimNode(gateRun.id, 'W', 'w'), null, 'A shared extra repo cannot be written while platform readers are active');
      await prisma.taskGraphNode.updateMany({ where: { runId: gateRun.id, key: { in: ['R1', 'R2'] } }, data: { status: 'passed' } });
      assert.ok(await claimNode(gateRun.id, 'W', 'w'));
      await prisma.taskGraphNode.update({ where: { runId_key: { runId: gateRun.id, key: 'R1' } }, data: { status: 'ready', claimToken: null } });
      assert.equal(await claimNode(gateRun.id, 'R1', 'r1-again'), null, 'An active writer blocks new readers');
    } finally { await prisma.taskGraphRun.delete({ where: { id: gateRun.id } }); }
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'claimed' } });
    const readonlyDefinition = structuredClone(definition); readonlyDefinition.nodes[1].extraRepositories![0].access = 'read';
    assert.notEqual(taskGraphSnapshotHash(definition), taskGraphSnapshotHash(readonlyDefinition), 'Changing access requires new approval');
    await assert.rejects(prepareExtraRepositories([{ repository: path.join(root, 'missing'), access: 'write' }]));
    assert.throws(() => validateTaskGraphDefinition({ ...definition, nodes: [{ ...definition.nodes[1], dependsOn: [], extraRepositories: [{ repository: 'relative', access: 'read' }] }] }));
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: process.env.PATH, AP_TASK_SANDBOX: '1', AP_PROJECT_REPOSITORY: main.directory, AP_SANDBOX_MODEL_ACCESS: '0' };
    const command = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(extra.directory, 'written'))},'ok');try{fs.writeFileSync(${JSON.stringify(path.join(extra.directory, '.git/config'))},'bad');process.exit(3)}catch{}try{fs.readFileSync(${JSON.stringify(path.join(hidden.directory, 'value'))});process.exit(4)}catch{}`;
    const wrapped = wrapWithBubblewrap({ command: process.execPath, commandArgs: ['-e', command], cwd: main.directory, workspaceRoot: main.directory,
      writableRoots: inputs.writablePaths, readOnlyPaths: inputs.paths, networkAccess: 'enabled', env });
    await runGraphCheck([wrapped.command, ...wrapped.args], main.directory, env);
    assert.equal(readFileSync(path.join(extra.directory, 'written'), 'utf8'), 'ok');
    for (const id of [child.id, 'task-graph-review-' + node.id, 'task-graph-architecture-' + node.id, 'task-graph-discussion-' + job.id]) {
      const read = await graphInputsForTask(id, true);
      assert.deepEqual(read.writablePaths, []); assert.ok(read.paths.includes(extra.directory));
    }
    await assert.rejects(runSandboxedGraphCheck(['sh', '-c', `echo forbidden > '${extra.directory}/should-not-exist'`], main.directory,
      { ...inputs.env, AP_GRAPH_SERVICE_TASK_ID: child.id }), /Read-only|read-only|Permission/);
    const require = createRequire(__filename);
    require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'fixture' } }));
    let nativeCalls = 0;
    getHarnessAdapter('codex')!.execute = async ({ task: nativeTask, context }) => {
      nativeCalls++;
      assert.ok(context.taskEnvironment?.TASK_GRAPH_EXTRA_REPOS_JSON);
      const review = nativeTask.id.startsWith('task-graph-review-');
      assert.equal(context.extraWritableRoots?.includes(extra.directory), !review);
      assert.equal(context.extraReadOnlyPaths?.includes(extra.directory), review);
      const wrapped = wrapWithBubblewrap({ command: process.execPath, commandArgs: ['-e', review
        ? `const fs=require('fs');try{fs.writeFileSync(${JSON.stringify(path.join(extra.directory, 'native-denied'))},'bad');process.exit(5)}catch{}`
        : `require('fs').writeFileSync(${JSON.stringify(path.join(extra.directory, 'native-written'))},'native')`],
        cwd: main.directory, workspaceRoot: context.workspaceRoot, writableRoots: context.extraWritableRoots,
        readOnlyPaths: context.extraReadOnlyPaths, sandboxMode: context.permissionConfig?.sandboxMode, networkAccess: 'enabled', env });
      await runGraphCheck([wrapped.command, ...wrapped.args], main.directory, env);
      return { success: true, output: 'native grant verified', executionTime: 1 };
    };
    const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex', role: 'implementer' };
    const execution = await executeAcpxTaskRun({ taskId: child.id, taskName: 'extra implementation', participants: [participant], orchestrationMode: 'single', workingDirectory: main.directory });
    assert.equal(execution.status, 'completed', JSON.stringify(execution));
    const reviewTask = await prisma.task.create({ data: { id: 'task-graph-review-' + node.id, name: 'review' } });
    const review = await executeAcpxTaskRun({ taskId: reviewTask.id, taskName: 'extra review', participants: [{ ...participant, role: 'tester' }], orchestrationMode: 'single', workingDirectory: main.directory,
      permissionConfig: { profile: 'custom', sandboxMode: 'read-only', networkAccess: 'enabled', approvalPolicy: 'never', writableRoots: [] } });
    assert.equal(review.status, 'completed'); assert.equal(nativeCalls, 2);
    assert.equal(readFileSync(path.join(extra.directory, 'native-written'), 'utf8'), 'native');
    assert.equal(existsSync(path.join(extra.directory, 'native-denied')), false);
    const saved = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadataWithProgress(saved.dispatchMetadata, {
      ...initialExecutionProgress(), phase: 'integrate', conflictRepair: {
        candidateCommit: main.commit, integrationCommit: main.commit, mergeHead: main.commit, paths: ['value'],
        indexOutside: '0'.repeat(64), worktreeOutside: '0'.repeat(64), originals: { value: '0'.repeat(64) }, stages: { value: '0'.repeat(64) },
      },
    }) } });
    const repair = await graphInputsForTask(child.id);
    assert.deepEqual(repair.writablePaths, [], 'Artifact-only conflict repair removes the approved extra repository write grant');
    assert.ok(repair.paths.includes(extra.directory), 'Conflict repair retains read access to the extra repository');
    const repairSandbox = wrapWithBubblewrap({ command: process.execPath, commandArgs: ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(extra.directory, 'repair-denied'))},'bad')`],
      cwd: main.directory, workspaceRoot: main.directory, writableRoots: repair.writablePaths, readOnlyPaths: repair.paths, networkAccess: 'enabled', env });
    await assert.rejects(runGraphCheck([repairSandbox.command, ...repairSandbox.args], main.directory, env), /EROFS|EACCES|Read-only|read-only|Permission/);
    assert.equal(existsSync(path.join(extra.directory, 'repair-denied')), false);
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { dispatchMetadata: metadataWithProgress(saved.dispatchMetadata, initialExecutionProgress()) } });
    const replay = await graphInputsForTask(child.id); assert.deepEqual(replay.writablePaths, inputs.writablePaths, 'Resume inherits the approved grant');
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'delivered_unverified' } });
    await cleanupCompletedNodeWorkspaces(run.id, 'B');
    assert.equal(readFileSync(path.join(extra.directory, 'temporary.tmp'), 'utf8'), 'keep original file');
    assert.ok(existsSync(path.join(extra.directory, '.git'))); assert.equal(readFileSync(path.join(extra.directory, 'written'), 'utf8'), 'ok');
    console.log('Approved extra repos: live source, read/write sandbox, protected Git metadata, readonly roles/checks, resume, approval hash and cleanup preservation verified');
  } finally { await prisma.taskGraphRun.delete({ where: { id: run.id } }); await prisma.$disconnect(); rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
