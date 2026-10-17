import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun } from '../src/lib/task-graph/store';
import { reclassifyIncompleteDelivery } from '../src/lib/task-graph/reclassify-delivery';
import { enqueueIssueSync, syncIssueDelivery, syncIssueReopen } from '../src/lib/task-graph/issue-sync';
import { graphRecoveryKind, scheduleImplementationRecovery } from '../src/lib/task-graph/implementation-result';
import { buildIssueGraph } from '../src/lib/task-graph/issue-route';
import type { TrackerRequest } from '../src/lib/task-graph/issue-tracker';

async function main() {
  const repository = mkdtempSync(path.join(tmpdir(), 'delivery-classify-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  writeFileSync(path.join(repository, 'code'), 'v1'); git('add', '.'); git('commit', '-m', 'base'); const commit = git('rev-parse', 'HEAD');
  const previousAdmin = process.env.FEISHU_ADMIN_OPEN_ID; process.env.FEISHU_ADMIN_OPEN_ID = 'admin';
  let posts = 0; const comments: { id: number; body: string }[] = [];
  const metadata = (sliceKey: string, parent: string | null) => `<!-- ap-ticket-v1 ${JSON.stringify({ version: 1, project: 'fixture', sliceKey, parent, blockedBy: [] })} -->`;
  const remote = [{ number: 'SPEC', title: 'Spec', body: metadata('SPEC', null), state: 'open' }, { number: 'A', title: 'Delivery', body: metadata('A', 'gitee:o/r#SPEC'), state: 'open' }];
  const request: TrackerRequest = async (_provider, endpoint, method, payload) => {
    if (endpoint.includes('/comments')) { if (method === 'POST') { comments.push({ id: ++posts, body: String(payload?.body) }); return comments.at(-1); } return comments; }
    if (method === 'PATCH') { remote[1].state = String(payload?.state); return {}; }
    if (endpoint.includes('?')) return remote;
    return remote.find(issue => endpoint.endsWith('/' + issue.number));
  };
  const definition = await buildIssueGraph('test://spec', { parent: 'gitee:o/r#SPEC', slices: { A: { executionMode: 'implement', acceptance: { mode: 'automatic', checks: [] },
    executions: [{ key: 'repo', repository, gitRef: 'refs/heads/main', baseCommit: commit, agentSelector: 'local:codex', instructions: 'fixture' }] } } }, request);
  const parent = await prisma.task.create({ data: { name: 'classify' } });
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition });
  const node = await prisma.taskGraphNode.findFirstOrThrow({ where: { runId: run.id } });
  const job = await prisma.taskGraphExecution.findFirstOrThrow({ where: { nodeId: node.id } });
  try {
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'delivered_unverified' } });
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', commit, taskRunId: 'original', evidence: { report: 'original' }, dispatchMetadata: { workspaceBase: commit } } });
    await enqueueIssueSync(); const old = await prisma.taskGraphEvent.findFirstOrThrow({ where: { nodeId: node.id, kind: 'issue_sync_requested' } });
    await syncIssueDelivery(old.id, request); assert.equal(posts, 1); assert.equal(remote[1].state, 'closed');
    const args = { runId: run.id, nodeKey: 'A', snapshotHash: run.snapshotHash, executionId: job.id, taskRunId: 'original', commit, actorId: 'admin', reason: 'audited blocked report', evidencePath: '/audit/report', blockerKind: 'environment_failed' as const };
    await assert.rejects(reclassifyIncompleteDelivery({ ...args, actorId: 'stranger' }), /管理员/);
    await assert.rejects(reclassifyIncompleteDelivery({ ...args, snapshotHash: 'changed' }), /审批版本/);
    const corrected = await reclassifyIncompleteDelivery(args); assert.equal((await reclassifyIncompleteDelivery(args)).id, corrected.id);
    assert.equal(await graphRecoveryKind(node.id), 'implementation');
    const reopen = await prisma.taskGraphEvent.findFirstOrThrow({ where: { nodeId: node.id, kind: 'issue_reopen_requested' } });
    await syncIssueReopen(reopen.id, request); await syncIssueReopen(reopen.id, request); assert.equal(remote[1].state, 'open');
    await scheduleImplementationRecovery(run.id, 'A', 'explicit-user-continue');
    assert.equal((await prisma.taskGraphExecution.findUniqueOrThrow({ where: { id: job.id } })).status, 'ready');
    await prisma.taskGraphExecution.update({ where: { id: job.id }, data: { status: 'integrated', taskRunId: 'new-attempt' } });
    await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: 'delivered_unverified' } });
    await enqueueIssueSync(); const requests = await prisma.taskGraphEvent.findMany({ where: { nodeId: node.id, kind: 'issue_sync_requested' }, orderBy: { createdAt: 'asc' } });
    assert.equal(requests.length, 2, 'New attempt gets a new receipt even with the same commit');
    assert.equal(await syncIssueDelivery(old.id, request), 'superseded'); assert.equal(posts, 1);
    await syncIssueDelivery(requests[1].id, request); await syncIssueDelivery(requests[1].id, request);
    assert.equal(posts, 2); assert.equal(remote[1].state, 'closed');
    assert.equal((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).snapshotHash, run.snapshotHash);
    assert.equal(await prisma.taskGraphEvent.count({ where: { nodeId: node.id, kind: 'issue_sync_completed' } }), 2, 'Both historical and new delivery receipts survive');
    console.log('Audited reclassification preserves approval/history, reopens Issues, restores implementation and supersedes old delivery receipts');
  } finally { if (previousAdmin === undefined) delete process.env.FEISHU_ADMIN_OPEN_ID; else process.env.FEISHU_ADMIN_OPEN_ID = previousAdmin; await prisma.taskGraphRun.delete({ where: { id: run.id } }); await prisma.$disconnect(); rmSync(repository, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
