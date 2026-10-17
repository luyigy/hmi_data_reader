import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { prisma } from '../src/lib/prisma';
import { createTaskGraphRun, releaseReadyNodes } from '../src/lib/task-graph/store';
import { taskGraphSnapshotHash, type GraphDefinition } from '../src/lib/task-graph/domain';
import { prepareExistingIssueAdoption, resolveRunIssueSource } from '../src/lib/task-graph/issue-adoption';
import { handleGraphProposalCardAction } from '../src/lib/task-graph/proposals';
import { enqueueIssueSync } from '../src/lib/task-graph/issue-sync';
import { buildGraphProposalCard } from '../src/lib/task-graph/proposal-card';
import { implementationInstructions } from '../src/lib/task-graph/prompts';
import { processPendingIssueAdoptions } from '../src/lib/task-graph/issue-adoption-worker';

async function main() {
  const repository = mkdtempSync(path.join(tmpdir(), 'adopt-existing-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  writeFileSync(path.join(repository, 'fixture'), 'accepted'); git('add', '.'); git('commit', '-m', 'accepted');
  const commit = git('rev-parse', 'HEAD');
  const require = createRequire(__filename);
  require('../src/lib/feishu-access-approval').isFeishuAdmin = () => true;
  require('../src/lib/task-graph/feishu').postGraphParentProgress = async () => {};
  const parent = await prisma.task.create({ data: { name: 'existing-adoption-' + randomUUID() } });
  const old: GraphDefinition = { specRef: 'old://spec', nodes: ['S03', 'S04', 'S05', 'R02A', 'R02B', 'S06'].map((key, index, keys) => ({
    key, goal: 'Goal ' + key, dependsOn: index ? [keys[index - 1]] : [], executionMode: 'lean', acceptance: { mode: 'automatic', checks: ['smoke'] },
    executions: [{ key: 'repo', instructions: 'Do ' + key, repository, gitRef: 'refs/heads/main', baseCommit: commit, agentSelector: 'local:codex', launchConfig: { participant: { gatewayId: 'local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' }, checks: [{ name: 'smoke', argv: ['true'] }] } }],
  })) };
  const run = await createTaskGraphRun({ parentTaskId: parent.id, version: 1, requestKey: parent.id, definition: old });
  const parentRef = 'gitee:org/app#IPARENT';
  const marker = (key: string, blockers: string[], parent: string | null) => '<!-- ap-ticket-v1 ' + JSON.stringify({ version: 1, project: 'adoption', sliceKey: key, parent, blockedBy: blockers }) + ' -->';
  const issues = [{ number: 'IPARENT', title: 'Spec', state: 'open', body: marker('SPEC', [], null) }, ...old.nodes.map((node) => ({
    number: 'I' + node.key, title: node.key, state: 'open', body: node.goal + '\n' + node.executions.map((job) => job.instructions).join('\n') + '\n' + marker(node.key, node.dependsOn.map((key) => 'gitee:org/app#I' + key), parentRef),
  }))];
  const request = async (_provider: string, endpoint: string) => endpoint.endsWith('/IPARENT') ? issues[0] : issues;
  require('../src/lib/task-graph/issue-tracker').trackerRequest = request;
  try {
    for (const key of ['S03', 'S04', 'S05']) {
      const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId: run.id, key } } });
      await prisma.taskGraphNode.update({ where: { id: node.id }, data: { status: key === 'S05' ? 'attention' : 'passed', evidence: { summary: 'existing evidence' } } });
      await prisma.taskGraphExecution.updateMany({ where: { nodeId: node.id }, data: { status: 'integrated', commit, evidence: { summary: 'existing commit evidence' } } });
    }
    const before = await prisma.taskGraphNode.findMany({ where: { runId: run.id }, include: { executions: true }, orderBy: { key: 'asc' } });
    const definition = await prepareExistingIssueAdoption({ runId: run.id, snapshotHash: run.snapshotHash, parentTaskId: parent.id, parent: parentRef }, request);
    const card = JSON.stringify(buildGraphProposalCard('test', definition, 2, taskGraphSnapshotHash(definition)));
    assert.match(card, /确认关联，保留进度/); assert.doesNotMatch(card, /确认并启动|"tag":"form"/);
    const readable = structuredClone(definition); readable.nodes[0].executions[0].agentSelector = 'platform_local:platform-local:codex';
    assert.doesNotMatch(JSON.stringify(buildGraphProposalCard('test', readable, 2, 'hash')), /platform_local:platform-local/);
    await assert.rejects(() => createTaskGraphRun({ parentTaskId: parent.id, version: 2, requestKey: 'must-not-copy', definition }), /must not create/);
    assert.equal(await resolveRunIssueSource(run.id), undefined, 'A proposal must not silently activate Issue synchronization');
    const room = await prisma.liveRoom.create({ data: { title: 'adoption', sourceTaskId: parent.id } });
    await prisma.feishuConversationBinding.create({ data: { scopeKey: parent.id, chatId: 'adoption-chat', chatType: 'p2p', liveRoomId: room.id } });
    const proposal = await prisma.taskGraphProposal.create({ data: { parentTaskId: parent.id, version: 2, createdBy: 'test', cardMessageId: 'adoption-card', snapshotHash: taskGraphSnapshotHash(definition), definition: JSON.parse(JSON.stringify(definition)) } });
    const action = { proposalId: proposal.id, decision: 'approve', hash: proposal.snapshotHash, openId: 'admin', chatId: 'adoption-chat', messageId: 'adoption-card' };
    issues[3].body += '\nnew scope';
    await handleGraphProposalCardAction(action);
    await processPendingIssueAdoptions();
    assert.equal(await resolveRunIssueSource(run.id), undefined);
    assert.equal((await prisma.taskGraphProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status, 'pending');
    issues[3].body = issues[3].body.replace('\nnew scope', '');
    await handleGraphProposalCardAction(action);
    await processPendingIssueAdoptions();
    await handleGraphProposalCardAction(action);
    assert.equal(await prisma.taskGraphRun.count({ where: { parentTaskId: parent.id } }), 1, 'Adoption must preserve the original run identity');
    assert.deepEqual(await prisma.taskGraphNode.findMany({ where: { runId: run.id }, include: { executions: true }, orderBy: { key: 'asc' } }), before, 'All task states, commits and evidence must remain unchanged');
    assert.equal((await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: run.id } })).snapshotHash, run.snapshotHash);
    assert.equal((await resolveRunIssueSource(run.id))?.parent, parentRef);
    assert.match(implementationInstructions({ ...old, issueSource: await resolveRunIssueSource(run.id) }, old.nodes[3]), /gitee:org\/app#IR02A/);
    await enqueueIssueSync(); await enqueueIssueSync();
    assert.equal(await prisma.taskGraphEvent.count({ where: { runId: run.id, kind: 'issue_sync_requested' } }), 2, 'Only the two approved historical results enter Issue sync');
    assert.deepEqual(await releaseReadyNodes(run.id), [], 'Missing-photo S05 must still block Reader and S06');
    assert.equal(await prisma.taskRun.count({ where: { taskId: { in: before.flatMap((node) => node.executions.flatMap((job) => job.childTaskId ? [job.childTaskId] : [])) } } }), 0);
    const changed = structuredClone(definition); changed.nodes[2].executionMode = 'implement';
    const { assertExistingIssueAdoption } = await import('../src/lib/task-graph/issue-adoption');
    await assert.rejects(() => assertExistingIssueAdoption(changed, request), /保持原获批/);
    console.log('Feishu Issue adoption preserves run/tasks/evidence, rejects changed scope and keeps S05 material gate closed');
  } finally {
    await prisma.taskGraphProposal.deleteMany({ where: { parentTaskId: parent.id } });
    await prisma.taskGraphRun.delete({ where: { id: run.id } });
    await prisma.liveRoom.deleteMany({ where: { sourceTaskId: parent.id } });
    await prisma.task.delete({ where: { id: parent.id } }); await prisma.$disconnect(); rmSync(repository, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
