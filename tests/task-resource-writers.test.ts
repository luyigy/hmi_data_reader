import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createGraphWriter } from '../src/lib/task-graph/writer-ownership';
import { exitedGraphWriter } from './fixtures/exited-graph-writer';
import { reserveResourceWriters } from '../src/lib/task-resources/writer-boundary';

async function main() {
  assert.match(new URL(process.env.DATABASE_URL || '').searchParams.get('schema') || '', /^task_graph_test_/);
  const root = await mkdtemp(join(tmpdir(), 'resource-writers-'));
  const tasks: string[] = [];
  const liveWriter = await createGraphWriter();
  async function directory(name: string) { const value = join(root, name); await mkdir(value, { recursive: true }); return value; }
  async function fixture(name: string, workspace: string, sandboxMode = 'workspace-write') {
    const task = await prisma.task.create({ data: { name, workingDirectory: workspace } }); tasks.push(task.id);
    const metadata = { graphWriter: liveWriter, permissionConfig: { writableRoots: [], sandboxMode } };
    const run = await prisma.taskRun.create({ data: { taskId: task.id, controlMetadata: JSON.stringify(metadata),
      participants: { create: { executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer', gatewayNameSnapshot: 'local' } } }, include: { participants: true } });
    return { run, participant: run.participants[0], metadata, workspace };
  }
  async function reserve(item: Awaited<ReturnType<typeof fixture>>, supplemental: string[], baseline = [item.workspace]) {
    return prisma.$transaction(async tx => {
      await reserveResourceWriters(tx, item.run.id, item.participant.id, baseline, supplemental);
      await tx.taskRunParticipant.update({ where: { id: item.participant.id }, data: { controlMetadata: JSON.stringify({ resources: { writableRoots: supplemental } }) } });
    }, { timeout: 20_000 });
  }
  try {
    const shared = await directory('shared'), nested = await directory('shared/nested');
    const archived = await fixture('archived ordinary task', await directory('archived'));
    await prisma.taskRun.update({ where: { id: archived.run.id }, data: { status: 'completed', controlMetadata: JSON.stringify({ permissionConfig: { profile: 'full_access', sandboxMode: 'danger-full-access' } }) } });
    const a = await fixture('writer a', await directory('a')), b = await fixture('writer b', await directory('b'));
    await prisma.taskRun.update({ where: { id: archived.run.id }, data: { status: 'running' } });
    await assert.rejects(reserve(a, [shared]), /writer exit is not proven/, 'An active legacy unrestricted process still blocks new writers');
    await prisma.taskRun.update({ where: { id: archived.run.id }, data: { status: 'completed' } });
    const contenders = await Promise.allSettled([reserve(a, [shared]), reserve(b, [nested])]);
    for (const result of contenders) if (result.status === 'rejected') assert.match(String(result.reason), /writer exit is not proven/);
    assert.equal(contenders.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(contenders.filter(result => result.status === 'rejected').length, 1);
    const winner = contenders[0].status === 'fulfilled' ? a : b, loser = winner === a ? b : a;
    await prisma.taskRun.update({ where: { id: winner.run.id }, data: { status: 'completed' } });
    await assert.rejects(reserve(loser, [shared]), /writer exit is not proven/);
    const exited = await exitedGraphWriter();
    await prisma.taskRun.update({ where: { id: winner.run.id }, data: { controlMetadata: JSON.stringify({ ...winner.metadata, graphWriter: exited }) } });
    await reserve(loser, [shared]);
    const sibling = await prisma.taskRunParticipant.create({ data: { taskRunId: loser.run.id, executionBackend: 'platform_local', harnessType: 'codex', role: 'reviewer', gatewayNameSnapshot: 'local' } });
    await prisma.$transaction(tx => reserveResourceWriters(tx, loser.run.id, sibling.id, [loser.workspace], [shared]));

    const base = await directory('baseline'), owner = await fixture('baseline owner', base);
    const extra = await fixture('supplemental applicant', await directory('extra'));
    await assert.rejects(reserve(extra, [base]), /writer exit is not proven/);
    const alias = join(root, 'baseline-alias'); await symlink(base, alias);
    await assert.rejects(reserve(extra, [alias]), /writer exit is not proven/);
    await prisma.taskRun.update({ where: { id: owner.run.id }, data: { controlMetadata: JSON.stringify({ ...owner.metadata, graphWriter: exited }) } });
    await reserve(extra, [base]);
    const baselineNew = await fixture('new baseline owner', base);
    await assert.rejects(reserve(baselineNew, []), /writer exit is not proven/);

    const unknownRoot = await directory('unknown'), unknown = await fixture('unknown writer', unknownRoot);
    await prisma.taskRun.update({ where: { id: unknown.run.id }, data: { status: 'failed', controlMetadata: '{}' } });
    await prisma.taskRunParticipant.update({ where: { id: unknown.participant.id }, data: { controlMetadata: JSON.stringify({ resources: { writableRoots: [unknownRoot] } }) } });
    await assert.rejects(reserve(extra, [unknownRoot]), /writer exit is not proven/);

    const readRoot = await directory('read-shared');
    const readerA = await fixture('reader a', readRoot, 'read-only'), readerB = await fixture('reader b', readRoot, 'read-only');
    await prisma.taskRunParticipant.update({ where: { id: readerA.participant.id }, data: { controlMetadata: JSON.stringify({ resources: { readOnlyRoots: [readRoot], writableRoots: [] } }) } });
    await reserve(readerA, [], []); await reserve(readerB, [], []);
    console.log('Supplemental writers serialize overlapping roots; baseline conflicts, actual exit, aliases and read sharing verified');
  } finally {
    await prisma.task.deleteMany({ where: { id: { in: tasks } } });
    await rm(root, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
