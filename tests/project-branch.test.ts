import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import {
  createBranchSwitchApproval,
  formatProjectBranchStatus,
  inspectProjectBranch,
  inspectProjectBranchTarget,
  resolveBranchSwitchApproval,
  updateProjectMonitoredBranch,
} from '../src/lib/scheduled-jobs/project-branch';
import { parseFeishuCommand } from '../src/lib/feishu-command-parser';
import { prisma } from '../src/lib/prisma';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

async function runTests() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-branch-'));
  let approvalId = '';
  try {
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.name', 'Test User');
    git(root, 'config', 'user.email', 'test@example.com');
    await fs.writeFile(path.join(root, 'README.md'), '# Test Repo');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-m', 'initial commit');
    git(root, 'checkout', '-b', 'feature/test-branch');
    await fs.mkdir(path.join(root, 'docs/workflow'), { recursive: true });
    await fs.mkdir(path.join(root, 'docs/codex/test-branch'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'docs/workflow/workflow-contract.yaml'),
      'branch_spaces:\n  root: docs/codex\n',
    );
    await fs.writeFile(path.join(root, 'docs/codex/test-branch/001_PLAN_20260808_test.md'), '# test');
    git(root, 'add', 'docs');
    git(root, 'commit', '-m', 'add workflow branch space');

    const job = {
      id: 'workflow-watcher',
      type: 'workflow_watcher',
      schedule: '* * * * *',
      enabled: true,
      mode: 'active' as const,
      config: {
        contract_path: 'docs/workflow/workflow-contract.yaml',
        branch_space: 'old-space',
      },
    };
    const project = {
      id: 'workflow-test',
      name: 'Workflow Test',
      path: root,
      ref: 'refs/heads/main',
      feishu: { chat_id: 'oc_test_chat', approver_open_ids: ['ou_admin_user'] },
      jobs: [job],
    };

    const info = await inspectProjectBranch(root, 'refs/heads/main');
    assert.equal(info.actualBranch, 'feature/test-branch');
    assert.equal(info.isDrifted, true);
    assert.match(formatProjectBranchStatus({ ...info, projectId: project.id, projectName: project.name }), /漂移警告/);

    const target = await inspectProjectBranchTarget(project, 'feature/test-branch');
    assert.deepEqual(target, {
      targetBranch: 'feature/test-branch',
      targetRef: 'refs/heads/feature/test-branch',
      branchSpace: 'test-branch',
      watchRoot: 'docs/codex/test-branch',
    });
    await assert.rejects(
      inspectProjectBranchTarget(project, 'feature/test-branch', 'missing-space'),
      /尚未提交 branch_space：docs\/codex\/missing-space/,
    );

    const configPath = path.join(root, 'projects.yaml');
    await fs.writeFile(configPath, `projects:\n  - id: demo\n    ref: refs/heads/main\n    jobs:\n      - type: workflow_watcher\n        config:\n          branch_space: old-space\n`);
    await updateProjectMonitoredBranch('demo', target.targetRef, target.branchSpace, configPath);
    const updated = parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(updated.projects[0].ref, target.targetRef);
    assert.equal(updated.projects[0].jobs[0].config.branch_space, target.branchSpace);

    const parsed = parseFeishuCommand({
      text: '/ap branch apply feature/test-branch --branch-space=test-branch',
      chatId: 'oc_test',
      chatType: 'p2p',
      senderOpenId: 'ou_user',
      messageId: 'msg_1',
      messageType: 'text',
      mentions: [],
      mentionNames: [],
    });
    assert.deepEqual(parsed?.args, ['apply', 'feature/test-branch']);
    assert.equal(parsed?.options['branch-space'], 'test-branch');

    const result = await createBranchSwitchApproval({
      project,
      targetBranch: target.targetBranch,
      requesterOpenId: 'ou_requester_user',
      requesterChatId: 'oc_test_chat',
    });
    approvalId = result.approvalId;
    assert(approvalId);
    const approval = await prisma.feishuAdminApproval.findUnique({ where: { id: approvalId } });
    const payload = JSON.parse(approval?.payloadJson || '{}');
    assert.equal(payload.branchSpace, 'test-branch');
    assert.equal(payload.watchRoot, 'docs/codex/test-branch');
    await assert.rejects(
      resolveBranchSwitchApproval({ approvalId, approved: true, actorOpenId: 'ou_random_user' }),
      /只有平台管理员或项目审批人/,
    );

    console.log('project branch checks passed');
  } finally {
    if (approvalId) await prisma.feishuAdminApproval.delete({ where: { id: approvalId } }).catch(() => undefined);
    await prisma.$disconnect();
    await fs.rm(root, { recursive: true, force: true });
  }
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
