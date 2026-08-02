import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completeWorkflowPlan } from '../src/lib/scheduled-jobs/workflow-plan-completion';

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workflow-plan-completion-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]).toString().trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'core.hooksPath', '/dev/null');
    mkdirSync(path.join(root, 'docs'));
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
    ].join('\n'));
    git('add', '.');
    git('commit', '-m', 'fixture');
    const ref = git('symbolic-ref', 'HEAD');
    const head = git('rev-parse', 'HEAD');
    const project = {
      id: 'project', name: 'Project', path: root, ref,
      feishu: { chat_id: 'chat', approver_open_ids: [] }, jobs: [],
    };

    const result = await completeWorkflowPlan({ project, planPath, expectedHead: head });
    assert.equal(result.state, 'completed');
    assert.match(readFileSync(path.join(root, planPath), 'utf8'), /doc_status: completed[\s\S]*next_action: await_acceptance/);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal((await completeWorkflowPlan({ project, planPath, expectedHead: result.head })).state, 'existing');
    assert.equal((await completeWorkflowPlan({ project, planPath, expectedHead: head })).state, 'stale');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
