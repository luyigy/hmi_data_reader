import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import { listSpecPackages } from '../src/lib/task-graph/spec-package';
import type { GraphDefinition } from '../src/lib/task-graph/domain';

async function main() {
  const id = randomUUID();
  const root = await mkdtemp(path.join(os.tmpdir(), 'proposal-delivery-'));
  process.env.SCHEDULED_JOB_WORKSPACE_ROOTS = root;
  const require = createRequire(__filename);
  const api = require('../src/lib/feishu-api');
  const roles = require('../src/lib/task-graph/role-configuration');
  const original = { image: api.uploadFeishuCardImage, file: api.sendFeishuMarkdownFile, card: api.sendFeishuInteractiveMessage, roles: roles.graphRoleOptions };
  const files: string[] = [];
  let rejectCard = true;
  api.sendFeishuMarkdownFile = async (args: { fileName: string }) => { files.push(args.fileName); return `file-message-${files.length}`; };
  api.sendFeishuInteractiveMessage = async () => { if (rejectCard) throw new Error('11310: element exceeds the limit'); return 'card-message'; };
  roles.graphRoleOptions = async () => [];
  api.uploadFeishuCardImage = async () => "test-image-key";
  const parent = await prisma.task.create({ data: { name: `proposal-retry-${id}` } });
  const room = await prisma.liveRoom.create({ data: { title: `retry-${id}`, sourceTaskId: parent.id } });
  try {
    const repository = path.join(root, 'repo');
    const directory = path.join(repository, 'docs/specs/pilot');
    await mkdir(directory, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Delivery test'); git('config', 'user.email', 'test@example.test');
    await writeFile(path.join(directory, 'spec-package.json'), JSON.stringify({ title: 'Retry', status: 'ready', spec: 'spec.md', route: 'route.json', artifacts: ['route-review.html'] }));
    await writeFile(path.join(directory, 'spec.md'), '# Frozen Spec');
    await writeFile(path.join(directory, 'route.json'), '{}');
    await writeFile(path.join(directory, 'route-review.html'), '<!doctype html><title>Route</title>');
    git('add', '.'); git('commit', '-m', 'Freeze Spec');
    const item = (await listSpecPackages(repository)).packages[0];
    const definition: GraphDefinition = { specRef: `${repository}/docs/specs/pilot/spec.md`,
      specPackage: { repository, commit: item.commit, manifestPath: item.manifestPath, hash: item.hash }, nodes: [
        { key: 'S03', goal: 'Projection', dependsOn: [], executionMode: 'lean', acceptance: { mode: 'automatic', checks: ['smoke'] }, executions: [
          { key: 'main', instructions: 'Implement', repository, gitRef: 'refs/heads/main', baseCommit: item.commit, agentSelector: 'local:codex',
            launchConfig: { participant: { gatewayId: 'local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' }, checks: [{ name: 'smoke', argv: ['true'] }] } },
        ] },
      ] };
    await prisma.feishuConversationBinding.create({ data: { scopeKey: `delivery-${id}`, chatId: `chat-${id}`, chatType: 'group',
      appId: 'test', rootMessageId: 'test-root', liveRoomId: room.id } });
    const { createGraphProposal } = await import('../src/lib/task-graph/proposals');
    const args = { parentTaskId: parent.id, definition, createdBy: 'test' };
    await assert.rejects(() => createGraphProposal(args), /11310/);
    assert.equal(files.length, 2);
    rejectCard = false;
    const proposal = await createGraphProposal(args);
    assert.equal(proposal.cardMessageId, 'card-message');
    assert.equal(files.length, 2, 'Retrying a rejected card must not resend Spec/HTML attachments');
    await createGraphProposal(args);
    assert.equal(files.length, 2);
    await createGraphProposal({ ...args, version: 2 });
    assert.equal(files.length, 2, 'A new proposal version must reuse unchanged attachments in the same topic');
    const { deliverGraphArtifact } = await import('../src/lib/task-graph/artifact-delivery');
    const uncertain = { parentTaskId: parent.id, chatId: `chat-${id}`, appId: 'test', rootMessageId: 'test-root', path: 'unknown.md', content: Buffer.from('changed content') };
    let attempts = 0;
    api.sendFeishuMarkdownFile = async () => { attempts++; throw new Error('connection lost after send'); };
    await assert.rejects(() => deliverGraphArtifact(uncertain), /connection lost/);
    await assert.rejects(() => deliverGraphArtifact(uncertain), /未重复发送/);
    assert.equal(attempts, 1, 'Unknown delivery must stop instead of blindly retrying');
    console.log('Proposal card retry preserves previously delivered Spec attachments');
  } finally {
    api.uploadFeishuCardImage = original.image; api.sendFeishuMarkdownFile = original.file; api.sendFeishuInteractiveMessage = original.card; roles.graphRoleOptions = original.roles;
    await prisma.taskGraphProposal.deleteMany({ where: { parentTaskId: parent.id } });
    await prisma.liveRoom.delete({ where: { id: room.id } });
    await prisma.task.delete({ where: { id: parent.id } });
    await prisma.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
