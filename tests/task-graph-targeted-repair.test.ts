import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { scheduleGraphRepair } from '../src/lib/task-graph/repair';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = mkdtempSync(path.join(os.tmpdir(), 'targeted-repair-'));
  const repos = ['reader', 'model'].map(key => {
    const repository = path.join(root, key); mkdirSync(repository);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost');
    writeFileSync(path.join(repository, 'source'), key); git('add', '.'); git('commit', '-m', 'candidate');
    return { key, repository, commit: git('rev-parse', 'HEAD') };
  });
  const task = await prisma.task.create({ data: { name: 'targeted repair' } });
  const run = await createTaskGraphRun({ parentTaskId: task.id, version: 1, requestKey: task.id, definition: {
    specRef: 'test://targeted-repair', nodes: [{ key: 'BOTH', goal: 'Joint behavior', dependsOn: [],
      acceptance: { mode: 'automatic', checks: ['contract'] }, executions: ['reader', 'model'].map(key => ({
        key, repository: repos.find(repo => repo.key === key)!.repository, gitRef: 'refs/heads/main', baseCommit: repos.find(repo => repo.key === key)!.commit,
        agentSelector: 'local:codex', instructions: key,
        launchConfig: { participant: { gatewayId: 'platform-local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' } },
      })),
    }],
  } });
  try {
    const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key: 'BOTH' } }, include: { executions: true } });
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'attention' } });
    for (const job of node.executions) {
      await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', commit: repos.find(repo => repo.key === job.key)!.commit, evidence: { summary: `${job.key} original evidence` } } });
    }
    const reader = node.executions.find(job => job.key === 'reader');
    const model = node.executions.find(job => job.key === 'model');
    assert(reader && model);
    const before = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: model.id } });
    const decision = { failureKind: 'in_scope_defect', failureKey: 'acceptance:contract', note: 'Reader misses required raw field', executionIds: [reader.id] };
    const evidence = { summary: 'Joint check found a reader defect', checks: [{ name: 'contract', passed: false, evidence: 'missing field' }] };
    assert.equal(await scheduleGraphRepair(run.id, 'BOTH', { ...decision, executionIds: ['another-node'] }, evidence), false);
    assert.equal(await scheduleGraphRepair(run.id, 'BOTH', { ...decision, failureKey: 'unknown' }, evidence), false);
    assert.equal(await scheduleGraphRepair(run.id, 'BOTH', { ...decision, executionIds: undefined }, evidence), false, 'Multi-execution defect needs explicit attribution');
    assert.equal(await scheduleGraphRepair(run.id, 'BOTH', decision, evidence), true);
    const after = await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: model.id } });
    assert.equal(after.status, 'integrated', 'Successful sibling must stay integrated and never be dispatched again');
    assert.equal(after.commit, before.commit);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.dispatchMetadata, before.dispatchMetadata);
    assert.equal(after.taskRunId, before.taskRunId);
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: reader.id } })).status, 'ready');
    console.log('Only affected execution is requeued; successful sibling commit and evidence remain unchanged');
  } finally {
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    await prisma.task.delete({ where: { id: task.id } });
    await prisma.$disconnect(); rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
