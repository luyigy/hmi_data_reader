import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completeWorkflowPlan } from '../src/lib/scheduled-jobs/workflow-plan-completion';
import { validateWorkflowDocuments } from '../src/lib/scheduled-jobs/workflow-validator';

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workflow-plan-completion-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]).toString().trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    mkdirSync(path.join(root, 'docs', 'workflow'), { recursive: true });
    const contractPath = 'docs/workflow/workflow-contract.yaml';
    writeFileSync(path.join(root, contractPath), readFileSync(path.join(process.cwd(), contractPath), 'utf8'));
    const planPath = 'docs/001_PLAN_20260802_fixture.md';
    writeFileSync(path.join(root, planPath), [
      '---',
      'doc_type: PLAN',
      'doc_status: ready',
      'next_action: start_first_slice',
      'plan_kind: phase',
      '---',
      '',
      '# PLAN · fixture',
      '',
      '## S01：fixture',
      '',
      '<!-- WORKFLOW_PROMPT_START -->',
      '执行 docs/001_PLAN_20260802_fixture.md 的 S01。',
      '<!-- WORKFLOW_PROMPT_END -->',
      '',
    ].join('\n'));
    const draftPlanPath = 'docs/002_PLAN_20260802_draft_fixture.md';
    writeFileSync(path.join(root, draftPlanPath), [
      '---',
      'doc_type: PLAN',
      'doc_status: draft',
      'next_action: await_plan_approval',
      'plan_kind: phase',
      '---',
      '',
      '# PLAN · draft fixture',
      '',
      '## S01：fixture',
      '',
    ].join('\n'));
    const invalidPlanPath = 'docs/003_PLAN_20260802_invalid_fixture.md';
    writeFileSync(path.join(root, invalidPlanPath), [
      '---',
      'doc_type: PLAN',
      'doc_status: draft',
      'next_action: await_plan_approval',
      'plan_kind: invalid',
      '---',
      '',
      '# PLAN · invalid fixture',
      '',
      '## S01：fixture',
      '',
    ].join('\n'));
    const lockedPlanPath = 'docs/004_PLAN_20260802_locked_fixture.md';
    writeFileSync(path.join(root, lockedPlanPath), readFileSync(path.join(root, draftPlanPath), 'utf8'));
    writeFileSync(path.join(root, 'staged.txt'), 'original staged\n');
    writeFileSync(path.join(root, 'unstaged.txt'), 'original unstaged\n');
    git('add', '.');
    git('commit', '-m', 'fixture');
    const ref = git('symbolic-ref', 'HEAD');
    const head = git('rev-parse', 'HEAD');
    const project = {
      id: 'project', name: 'Project', path: root, ref,
      feishu: { chat_id: 'chat', approver_open_ids: [] }, jobs: [],
    };
    writeFileSync(path.join(root, 'staged.txt'), 'changed staged\n');
    git('add', 'staged.txt');
    writeFileSync(path.join(root, 'unstaged.txt'), 'changed unstaged\n');
    writeFileSync(path.join(root, 'untracked.txt'), 'untracked\n');
    const unrelatedStatus = git('status', '--porcelain', '--', 'staged.txt', 'unstaged.txt', 'untracked.txt');
    const hookPath = path.join(root, '.git', 'hooks', 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
    chmodSync(hookPath, 0o755);

    const result = await completeWorkflowPlan({ project, planPath, contractPath, expectedHead: head });
    assert.equal(result.state, 'completed');
    const completed = readFileSync(path.join(root, planPath), 'utf8');
    assert.match(completed, /doc_status: completed[\s\S]*next_action: await_acceptance/);
    assert.doesNotMatch(completed, /WORKFLOW_PROMPT_(?:START|END)/);
    assert.equal((await validateWorkflowDocuments({
      cwd: root,
      ref: result.head,
      filePaths: [planPath],
      contractPath,
    }))[0].action, 'await_acceptance');
    assert.equal(git('status', '--porcelain', '--', 'staged.txt', 'unstaged.txt', 'untracked.txt'), unrelatedStatus);
    const draftResult = await completeWorkflowPlan({
      project, planPath: draftPlanPath, contractPath, expectedHead: result.head,
    });
    assert.equal(draftResult.state, 'completed');
    assert.equal((await validateWorkflowDocuments({
      cwd: root,
      ref: draftResult.head,
      filePaths: [draftPlanPath],
      contractPath,
    }))[0].action, 'await_acceptance');
    assert.equal((await completeWorkflowPlan({
      project, planPath: draftPlanPath, contractPath, expectedHead: draftResult.head,
    })).state, 'existing');
    await assert.rejects(
      completeWorkflowPlan({
        project, planPath: invalidPlanPath, contractPath, expectedHead: draftResult.head,
      }),
      /PLAN_KIND_INVALID/,
    );
    writeFileSync(path.join(root, invalidPlanPath), `${readFileSync(path.join(root, invalidPlanPath), 'utf8')}dirty\n`);
    await assert.rejects(
      completeWorkflowPlan({
        project, planPath: invalidPlanPath, contractPath, expectedHead: draftResult.head,
      }),
      /目标 PLAN 存在 staged、unstaged 或 untracked 改动/,
    );
    git('restore', '--', invalidPlanPath);
    writeFileSync(path.join(root, '.git', 'index.lock'), 'locked');
    await assert.rejects(
      completeWorkflowPlan({
        project, planPath: lockedPlanPath, contractPath, expectedHead: draftResult.head,
      }),
      /Git 索引锁忙，请稍后重试/,
    );
    rmSync(path.join(root, '.git', 'index.lock'));
    assert.equal(git('status', '--porcelain', '--', lockedPlanPath), '');
    assert.equal(git('rev-parse', 'HEAD'), draftResult.head);
    assert.equal(git('status', '--porcelain', '--', 'staged.txt', 'unstaged.txt', 'untracked.txt'), unrelatedStatus);
    assert.equal((await completeWorkflowPlan({ project, planPath, contractPath, expectedHead: head })).state, 'stale');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
