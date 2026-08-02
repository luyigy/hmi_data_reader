import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    git('config', 'core.hooksPath', '/dev/null');
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
    git('add', '.');
    git('commit', '-m', 'fixture');
    const ref = git('symbolic-ref', 'HEAD');
    const head = git('rev-parse', 'HEAD');
    const project = {
      id: 'project', name: 'Project', path: root, ref,
      feishu: { chat_id: 'chat', approver_open_ids: [] }, jobs: [],
    };

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
    assert.equal(git('status', '--porcelain'), '');
    assert.equal((await completeWorkflowPlan({ project, planPath, contractPath, expectedHead: result.head })).state, 'existing');
    assert.equal((await completeWorkflowPlan({ project, planPath, contractPath, expectedHead: head })).state, 'stale');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
