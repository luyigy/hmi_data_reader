import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { taskGraphSnapshotHash, validateTaskGraphDefinition, type GraphDefinition } from '../src/lib/task-graph/domain';

async function main() {
  const repository = await mkdtemp(path.join(tmpdir(), 'approval-snapshot-'));
  process.env.SCHEDULED_JOB_WORKSPACE_ROOTS = repository;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Snapshot test'); git('config', 'user.email', 'test@example.test');
  await writeFile(path.join(repository, 'fixture'), 'baseline');
  git('add', '.'); git('commit', '-m', 'Baseline');
  const require = createRequire(__filename);
  const auth = require('../src/lib/feishu-access-approval');
  const progress = require('../src/lib/task-graph/feishu');
  const originals = { admin: auth.isFeishuAdmin, progress: progress.postGraphParentProgress };
  auth.isFeishuAdmin = () => true;
  progress.postGraphParentProgress = async () => {};
  const { handleGraphProposalCardAction } = await import('../src/lib/task-graph/proposals');
  const definition: GraphDefinition = { specRef: 'spec.md@fixed', nodes: [{ key: 'V1', goal: 'Deliver result', dependsOn: [],
    executionMode: 'lean', acceptance: { mode: 'automatic', checks: ['smoke'] }, executions: [{
      key: 'app', instructions: 'Implement result', repository, gitRef: 'refs/heads/main',
      baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'local:codex', launchConfig: {
        participant: { gatewayId: 'local', harnessType: 'codex', executionBackend: 'platform_local', role: 'implementer' },
        checks: [{ name: 'smoke', argv: ['node', 'verify.js'] }],
      },
    }] }] };
  const hash = taskGraphSnapshotHash(definition);
  const parent = await prisma.task.create({ data: { name: `snapshot-${randomUUID()}` } });
  try {
    const stored = await prisma.taskGraphProposal.create({ data: { parentTaskId: parent.id, version: 1,
      createdBy: 'test', cardMessageId: 'test-card', definition: JSON.parse(JSON.stringify(definition)), snapshotHash: hash } });
    const restored = validateTaskGraphDefinition(stored.definition as unknown as GraphDefinition);
    assert.equal(taskGraphSnapshotHash(restored), stored.snapshotHash,
      'Approval snapshot hash must survive a PostgreSQL JSONB round trip');
    const changed = structuredClone(restored);
    changed.nodes[0].executions[0].agentSelector = 'local:pi-agent';
    assert.notEqual(taskGraphSnapshotHash(changed), hash, 'Changing the implementer must invalidate the card');
    changed.nodes[0].executions[0].agentSelector = definition.nodes[0].executions[0].agentSelector;
    const argv = changed.nodes[0].executions[0].launchConfig as { checks: { argv: string[] }[] };
    argv.checks[0].argv.reverse();
    assert.notEqual(taskGraphSnapshotHash(changed), hash, 'Command argument ordering must remain significant');
    const room = await prisma.liveRoom.create({ data: { title: 'Snapshot approval', sourceTaskId: parent.id } });
    await prisma.feishuConversationBinding.create({ data: { scopeKey: `approval-${parent.id}`, chatId: 'test-chat',
      rootMessageId: 'test-root', chatType: 'group', appId: 'test', liveRoomId: room.id } });
    const action = { proposalId: stored.id, hash, decision: 'approve', openId: 'test-admin', chatId: 'test-chat', messageId: 'test-card' };
    const approved = await handleGraphProposalCardAction(action);
    assert.equal(approved.toast.type, 'success');
    assert.equal((await prisma.taskGraphProposal.findUniqueOrThrow({ where: { id: stored.id } })).status, 'confirmed');
    const run = await prisma.taskGraphRun.findFirstOrThrow({ where: { parentTaskId: parent.id }, include: { nodes: true } });
    assert.equal(run.nodes[0].status, 'ready', 'Successful approval must release the first Slice');
    await handleGraphProposalCardAction(action);
    assert.equal(await prisma.taskGraphRun.count({ where: { parentTaskId: parent.id } }), 1, 'Repeated approval must not start another run');
    console.log('Task graph snapshot survives PostgreSQL JSONB while content changes invalidate approval');
  } finally {
    auth.isFeishuAdmin = originals.admin;
    progress.postGraphParentProgress = originals.progress;
    await prisma.taskGraphRun.deleteMany({ where: { parentTaskId: parent.id } });
    await prisma.liveRoom.deleteMany({ where: { sourceTaskId: parent.id } });
    await prisma.taskGraphProposal.deleteMany({ where: { parentTaskId: parent.id } });
    await prisma.task.delete({ where: { id: parent.id } });
    await prisma.$disconnect();
    await rm(repository, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
