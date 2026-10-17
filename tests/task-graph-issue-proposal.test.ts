import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prisma } from '../src/lib/prisma';
import type { IssueRouteSettings } from '../src/lib/task-graph/issue-route';

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'issue-proposal-'));
  process.env.SCHEDULED_JOB_WORKSPACE_ROOTS = root;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Issue test'); git('config', 'user.email', 'test@example.test');
  await writeFile(path.join(root, 'fixture'), 'baseline'); git('add', '.'); git('commit', '-m', 'baseline');
  git('branch', 'execution');
  const parentRef = 'gitee:org/app#IPARENT';
  const body = (key: string, blockers: string[], parent: string | null = parentRef) => 'criteria\n<!-- ap-ticket-v1 ' + JSON.stringify({ version: 1, project: 'fixture', sliceKey: key, parent, blockedBy: blockers }) + ' -->';
  const remote = [{ number: 'IPARENT', title: 'Spec', state: 'open', body: body('SPEC', [], null) },
    ...['A', 'B', 'C'].map((key) => ({ number: 'I' + key, title: key, state: 'open', body: body(key, key === 'C' ? ['gitee:org/app#IA', 'gitee:org/app#IB'] : []) }))];
  const require = createRequire(__filename);
  const tracker = require('../src/lib/task-graph/issue-tracker');
  const api = require('../src/lib/feishu-api');
  const auth = require('../src/lib/feishu-access-approval');
  const progress = require('../src/lib/task-graph/feishu');
  const roles = require('../src/lib/task-graph/role-configuration');
  tracker.trackerRequest = async (_provider: string, endpoint: string) => endpoint === '/repos/org/app/issues/IPARENT' ? remote[0] : remote;
  auth.isFeishuAdmin = () => true;
  progress.postGraphParentProgress = async () => {};
  roles.graphRoleOptions = async () => [];
  let cards = 0; let files = 0;
  api.sendFeishuMarkdownFile = async () => { files++; return 'file-' + files; };
  api.sendFeishuInteractiveMessage = async () => { cards++; return 'card-' + cards; };
  const parent = await prisma.task.create({ data: { name: 'Issue import test', workingDirectory: root } });
  try {
    const slice = { executionMode: 'lean' as const, acceptance: { mode: 'automatic' as const, checks: ['smoke'] }, executions: [{
      key: 'app', instructions: 'This repo', repository: root, gitRef: 'refs/heads/execution', baseCommit: git('rev-parse', 'HEAD'), agentSelector: 'local:codex',
      launchConfig: { participant: { gatewayId: 'local', executionBackend: 'platform_local', harnessType: 'codex', role: 'implementer' }, checks: [{ name: 'smoke', argv: ['true'] }] },
    }] };
    const settings: IssueRouteSettings = { parent: parentRef, slices: { A: slice, B: slice, C: slice } };
    const directory = path.join(root, 'docs/specs/fixture');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'spec.md'), '# Spec');
    await writeFile(path.join(directory, 'route-review.html'), '<!doctype html><title>Review</title>');
    await writeFile(path.join(directory, 'spec-package.json'), JSON.stringify({ title: 'Issue spec', status: 'ready', spec: 'spec.md', artifacts: ['route-review.html'], issueRoute: settings }));
    git('add', '.'); git('commit', '-m', 'Spec package');
    const room = await prisma.liveRoom.create({ data: { title: 'Issue room', sourceTaskId: parent.id } });
    await prisma.feishuConversationBinding.create({ data: { scopeKey: parent.id, chatId: 'issue-test-chat', rootMessageId: 'issue-root', chatType: 'group', appId: 'fixture', liveRoomId: room.id } });
    const { proposeIssueSpec } = await import('../src/lib/task-graph/propose-spec');
    const args = { repository: root, commit: git('rev-parse', 'HEAD'), manifestPath: 'docs/specs/fixture/spec-package.json', parentTaskId: parent.id, createdBy: 'test' };
    const proposal = await proposeIssueSpec(args);
    const again = await proposeIssueSpec(args);
    assert.equal(again.id, proposal.id); assert.equal(cards, 1); assert.equal(files, 2);
    assert.equal(await prisma.taskGraphRun.count({ where: { parentTaskId: parent.id } }), 0, 'Propose must not dispatch');
    const { handleGraphProposalCardAction } = await import('../src/lib/task-graph/proposals');
    const action = { proposalId: proposal.id, hash: proposal.snapshotHash, decision: 'approve', openId: 'admin', chatId: 'issue-test-chat', messageId: proposal.cardMessageId };
    remote[1].body += '\nnew criteria';
    await assert.rejects(() => handleGraphProposalCardAction(action), /重新提审/);
    assert.equal(await prisma.taskGraphRun.count({ where: { parentTaskId: parent.id } }), 0);
    remote[1].body = body('A', []);
    remote[3].state = 'closed';
    await handleGraphProposalCardAction(action);
    await handleGraphProposalCardAction(action);
    const run = await prisma.taskGraphRun.findFirstOrThrow({ where: { parentTaskId: parent.id }, include: { nodes: true } });
    assert.deepEqual(run.nodes.sort((a, b) => a.key.localeCompare(b.key)).map((node) => [node.key, node.status]), [['A', 'ready'], ['B', 'ready'], ['C', 'planned']]);
    assert.equal(await prisma.taskGraphRun.count({ where: { parentTaskId: parent.id } }), 1);
    console.log('Committed Issue Spec produces one compact Feishu approval; drift blocks launch and remote close cannot unlock dependencies');
  } finally {
    await prisma.taskGraphRun.deleteMany({ where: { parentTaskId: parent.id } });
    await prisma.taskGraphProposal.deleteMany({ where: { parentTaskId: parent.id } });
    await prisma.liveRoom.deleteMany({ where: { sourceTaskId: parent.id } });
    await prisma.task.delete({ where: { id: parent.id } });
    await prisma.$disconnect(); await rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
