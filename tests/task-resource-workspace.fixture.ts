import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { materializeUpstream } from '../src/lib/task-graph/upstream-source';
import { graphInputsForTask } from '../src/lib/task-graph/upstream-inputs';
import { requestResourceAccess, decideResourceAccess } from '../src/lib/task-resources/access';
import { resourcesForRun } from '../src/lib/task-resources/runtime';
import { prepareSandboxEnvironment } from '../src/lib/sandbox-manager/environment';
import { renderBubblewrap } from '../src/lib/sandbox-manager/bubblewrap';
import type { AcpxRunRequest } from '../src/lib/acpx/types';

export async function resourceWorkspaceRegression() {
  const root = mkdtempSync(path.join(tmpdir(), 'resource-workspace-'));
  const savedRoot = process.env.AP_WORKSPACE_ROOT, savedUpstream = process.env.TASK_GRAPH_UPSTREAM_ROOT;
  process.env.AP_WORKSPACE_ROOT = path.join(root, 'workspaces');
  process.env.TASK_GRAPH_UPSTREAM_ROOT = path.join(root, 'inputs');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const makeRepo = (name: string) => {
    const dir = path.join(root, name); mkdirSync(dir); git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.name', 'Fixture'); git(dir, 'config', 'user.email', 'fixture@localhost');
    writeFileSync(path.join(dir, 'source.js'), 'module.exports = 1;\n'); git(dir, 'add', '.'); git(dir, 'commit', '-m', 'fixed');
    return dir;
  };
  const repository = makeRepo('main'), reader = makeRepo('reader'), base = git(reader, 'rev-parse', 'HEAD');
  writeFileSync(path.join(reader, 'source.js'), 'uncommitted shared source');
  const participant = { gatewayId: 'platform-local', executionBackend: 'platform_local' as const, harnessType: 'codex' as const, role: 'implementer' };
  let graphId = '', approvalId = '';
  try {
    const parent = await prisma.task.create({ data: { name: 'supplemental fixed workspace' } });
    const graph = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: {
      specRef: 'fixture://resource-workspace', nodes: [{ key: 'M06', goal: 'write fixed Reader', dependsOn: [], executionMode: 'implement',
        extraRepositories: [{ repository: reader, access: 'read' }], acceptance: { mode: 'automatic', checks: [] },
        executions: [{ key: 'main', repository, gitRef: 'refs/heads/main', baseCommit: git(repository, 'rev-parse', 'HEAD'), agentSelector: 'local:codex', instructions: 'fixture', launchConfig: { participant } }] }] } });
    graphId = graph.id;
    const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: graph.id } } });
    const task = await prisma.task.create({ data: { id: `task-graph-${job.id}`, name: 'M06', workingDirectory: repository } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: task.id, worktreePath: repository, claimToken: 'current-claim' } });
    const sourcePath = await materializeUpstream(reader, base);
    const content = { version: 1 as const, executionId: job.id, primaryRepository: repository,
      inputs: [{ repository: reader, commit: base, sourcePath, executions: ['INPUT/reader'], resultsDirectories: [], projectEnvPath: null, pythonExecutable: null, dependencyPaths: [], quality: ['passed'] }] };
    const manifest = { ...content, hash: createHash('sha256').update(JSON.stringify(content)).digest('hex') };
    await prisma.taskGraphEvent.create({ data: { runId: graph.id, nodeId: job.nodeId, kind: 'task_inputs_prepared', idempotencyKey: `execution:${job.id}:inputs:current-claim`, payload: manifest } });
    const request: AcpxRunRequest = { taskId: task.id, taskName: 'M06', orchestrationMode: 'single', participants: [participant], workingDirectory: repository,
      graphExecution: { executionId: job.id, claimToken: 'current-claim', revision: 0 }, extraReadOnlyPaths: [reader],
      permissionConfig: { profile: 'dev_local', sandboxMode: 'workspace-write', networkAccess: 'restricted', approvalPolicy: 'never', writableRoots: [repository] } };
    const grant = await requestResourceAccess({ launch: request, requesterOpenId: 'fixture', requesterChatId: 'fixture', purpose: 'Reader edit', resources: [{ path: reader, access: 'write' }] });
    assert(grant.kind === 'request'); approvalId = grant.approval.id;
    await decideResourceAccess({ id: approvalId, revision: 1, actorOpenId: process.env.FEISHU_ADMIN_OPEN_ID!, action: 'approve' });
    const run = await prisma.taskRun.create({ data: { taskId: task.id, participants: { create: { ...participant, gatewayNameSnapshot: 'local' } } }, include: { participants: true } });
    const inputs = await graphInputsForTask(task.id);
    const access = await resourcesForRun(request, run.id, run.participants[0].id, inputs.manifests);
    assert.equal(access.write.length, 1); const checkout = access.write[0];
    assert.notEqual(checkout, reader); assert.notEqual(checkout, sourcePath);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), base);
    assert.match(access.instructions, /checkout/);
    const script = `const fs=require('fs'),a=require('assert/strict'),p=${JSON.stringify(checkout)};a.equal(require(p+'/source.js'),1);fs.writeFileSync(p+'/source.js','module.exports = 2;');fs.writeFileSync(p+'/regression.js','require("assert/strict").equal(require("./source"),2)');require('child_process').execFileSync(process.execPath,[p+'/regression.js']);a.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(reader, 'source.js'))},'bad'));a.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(sourcePath, 'source.js'))},'bad'));a.throws(()=>fs.writeFileSync(p+'/.git','bad'));`;
    const plan = prepareSandboxEnvironment({ command: process.execPath, commandArgs: ['-e', script], cwd: repository, workspaceRoot: repository,
      writableRoots: access.write, requiredWritableRoots: access.write, readOnlyPaths: [...inputs.paths, ...access.protectedPaths], env: { ...process.env, AP_RESOURCE_SCOPE: '1' }, sandboxMode: 'workspace-write' });
    const command = renderBubblewrap(plan); const result = spawnSync(command.command, command.args, { env: plan.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const shadow = renderBubblewrap({ ...plan, explicitReadOnlyMounts: [...plan.explicitReadOnlyMounts, checkout], commandArgs: ['-e', 'console.log("native-must-not-start")'] });
    const rejected = spawnSync(shadow.command, shadow.args, { env: plan.env, encoding: 'utf8' });
    assert.equal(rejected.status, 73); assert.match(rejected.stderr, /Approved resource is not writable/); assert(!rejected.stdout.includes('native-must-not-start'));
    assert.equal(require('fs').readdirSync(checkout).filter((name: string) => name.startsWith('.ap-write-check-')).length, 0);
    assert.equal(readFileSync(path.join(reader, 'source.js'), 'utf8'), 'uncommitted shared source');
    const replay = await resourcesForRun(request, run.id, run.participants[0].id, inputs.manifests);
    assert.deepEqual(replay.write, access.write); assert.equal(readFileSync(path.join(checkout, 'source.js'), 'utf8'), 'module.exports = 2;');
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { claimToken: 'changed' } });
    await assert.rejects(resourcesForRun(request, run.id, run.participants[0].id, inputs.manifests), /执行身份改变/);
    console.log('Approved Reader grant maps to pinned private checkout; real sandbox edits and regression succeed; shared source, fixed input and Git stay readonly; replay preserves edits; changed claim rejected');
  } finally {
    if (approvalId) await prisma.feishuAdminApproval.delete({ where: { id: approvalId } });
    if (graphId) await prisma.taskGraphRun.delete({ where: { id: graphId } });
    if (savedRoot === undefined) delete process.env.AP_WORKSPACE_ROOT; else process.env.AP_WORKSPACE_ROOT = savedRoot;
    if (savedUpstream === undefined) delete process.env.TASK_GRAPH_UPSTREAM_ROOT; else process.env.TASK_GRAPH_UPSTREAM_ROOT = savedUpstream;
    rmSync(root, { recursive: true, force: true });
  }
}
