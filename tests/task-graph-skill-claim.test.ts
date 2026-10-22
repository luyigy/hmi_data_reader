import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, releaseReadyNodes, claimNode, claimExecution } from '../src/lib/task-graph/store';
import { applyExecutionOutcome, executionProgress } from '../src/lib/task-graph/execution-progress';
import { migrateLegacyProjectScope } from '../src/lib/project-capabilities/legacy-scope';
import { prepareTaskDeclaredRuntime } from '../src/lib/task-graph/runtime-continuity';
import { runtimeResourceDigest, type RuntimeDeclaration } from '../src/lib/task-graph/runtime-contract';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'skill-claim-'));
  const oldHome = process.env.HOME, oldApp = process.env.FEISHU_APP_ID;
  process.env.HOME = path.join(scratch, 'home'); process.env.FEISHU_APP_ID = 'cli_test';
  try {
    const repository = path.join(scratch, 'repo'), bundle = path.join(scratch, 'skills'), output = path.join(scratch, 'out');
    for (const dir of [repository, bundle, output]) await fs.mkdir(dir);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    await fs.writeFile(path.join(repository, 'source'), 'fixed candidate'); git('add', '.'); git('commit', '-m', 'fixture');
    for (const name of ['how', 'architect', 'principle-model-the-domain']) {
      await fs.mkdir(path.join(bundle, name)); await fs.writeFile(path.join(bundle, name, 'SKILL.md'), `${name} fixed instructions`);
    }
    await fs.writeFile(path.join(bundle, 'check.cjs'), "const fs=require('fs');for(const n of ['how','architect','principle-model-the-domain'])fs.readFileSync(__dirname+'/'+n+'/SKILL.md');console.log('three required skills read inside sandbox');");
    const user = await prisma.user.create({ data: { username: scratch, passwordHash: 'fixture' } });
    const parent = await prisma.task.create({ data: { name: 'Skill upgrade at natural claim boundary', ownerUserId: user.id } });
    const project: { repository: string; appId: string; principals: string[]; readOnlyRoots: string[]; sources: []; runtime?: RuntimeDeclaration } = { repository, appId: 'cli_test', principals: ['platform:' + user.id], readOnlyRoots: [], sources: [] };
    const policyFile = path.join(process.env.HOME, '.agent-platform/project-capabilities.json'); await fs.mkdir(path.dirname(policyFile), { recursive: true });
    const save = () => fs.writeFile(policyFile, JSON.stringify({ version: 1, projects: [project] })); await save();
    const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: { specRef: 'test://legacy-skill-upgrade', nodes: [{ key: 'M6', goal: 'test', dependsOn: [], acceptance: { mode: 'automatic', checks: ['behavior'] }, executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'local:codex', instructions: 'test' }] }] } });
    const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { node: { runId: run.id } } });
    const child = await prisma.task.create({ data: { id: 'task-graph-' + job.id, name: 'original task' } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { childTaskId: child.id, worktreePath: repository } });
    const approve = async () => { const preview = await migrateLegacyProjectScope({ executionId: job.id }); return migrateLegacyProjectScope({ executionId: job.id, apply: true, expectedPolicyHash: preview.policyHash }); };
    await approve(); await releaseReadyNodes(run.id); await claimNode(run.id, 'M6', 'node-claim');
    assert(await claimExecution(run.id, 'M6', 'repo', 'old-claim'));
    const candidate = git('rev-parse', 'HEAD');
    const checkpoint = await applyExecutionOutcome({ executionId: job.id, claimToken: 'old-claim', expectedRevision: 0, outcomeId: 'checkpoint', outcome: { kind: 'checkpoint', phase: 'implement', candidateCommit: candidate, workspaceBase: candidate } });
    const prepare = () => prepareTaskDeclaredRuntime({ taskId: child.id, workspace: repository, approvedReadOnlyRoots: [], outputDirectory: output });
    await prepare(); const oldPin = await prisma.taskGraphEvent.findFirstOrThrow({ where: { runId: run.id, kind: 'runtime_snapshot_pinned' } });
    project.readOnlyRoots.push(bundle); project.runtime = { version: 1, skills: [{ id: 'engineering', package: { kind: 'path', path: bundle, sha256: await runtimeResourceDigest(bundle) }, requiredFiles: ['how/SKILL.md', 'architect/SKILL.md', 'principle-model-the-domain/SKILL.md'], checkScript: 'check.cjs' }] }; await save();
    await assert.rejects(prepare(), /授权|范围/);
    await assert.rejects(approve(), /写入者|快照/);
    const continued = await applyExecutionOutcome({ executionId: job.id, claimToken: 'old-claim', expectedRevision: checkpoint.revision, outcomeId: 'normal-completion', outcome: { kind: 'continue_work', note: 'not delivered', fingerprint: 'a'.repeat(64) } });
    const ready = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } }); assert.equal(ready.claimToken, null); assert.equal(ready.status, 'ready');
    await approve(); assert(await claimExecution(run.id, 'M6', 'repo', 'new-claim'));
    const prepared = await prepare(); assert.match(prepared.receipt?.skills?.[0]?.output || '', /three required skills read/);
    const after = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(after.childTaskId, child.id); assert.equal(after.worktreePath, repository);
    assert.equal(executionProgress(after.dispatchMetadata)?.candidateCommit, candidate);
    for (const counter of ['platformAttempts', 'formatAttempts', 'repairAttempts', 'integrationAttempts'] as const) assert.equal(executionProgress(after.dispatchMetadata)?.[counter], continued[counter]);
    assert.deepEqual((await prisma.taskGraphEvent.findUniqueOrThrow({ where: { id: oldPin.id } })).payload, oldPin.payload);
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'runtime_snapshot_pinned' } }), 2);
    console.log('PASS explicit skill scope at a natural ready/new-claim boundary; three actual sandbox reads, immutable old pin, same task/worktree/candidate and unchanged budgets');
    await prisma.taskGraphRun.delete({ where: { id: run.id } }); await prisma.task.deleteMany({ where: { id: { in: [parent.id, child.id] } } }); await prisma.user.delete({ where: { id: user.id } });
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = oldApp;
    await prisma.$disconnect(); await fs.rm(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
