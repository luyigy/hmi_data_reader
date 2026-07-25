import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workflowWatcherHandler } from '../src/lib/scheduled-jobs/workflow-watcher';
import type { JobConfig, ProjectConfig } from '../src/lib/scheduled-jobs/project-config';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-watcher-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await mkdir(path.join(root, 'docs/workflow'), { recursive: true });
  await mkdir(path.join(root, 'docs/branch/main'), { recursive: true });
  await writeFile(path.join(root, 'docs/workflow/workflow-contract.yaml'), `
documents:
  automation_types: [PLAN, HANDOVER]
  filename_pattern: "^(?P<number>[0-9]+)_(?P<doc_type>[A-Z]+)_(?P<date>[0-9]{8})_.+\\\\.md$"
  common_required_fields: [doc_type, doc_status, next_action]
  plan:
    executable_actions: [start_first_slice]
    start_action: start_first_slice
  handover:
    executable_actions: [next_slice, resume_parent]
actions:
  executable: [start_first_slice, next_slice, resume_parent]
  terminal: [await_acceptance, blocked, none]
branch_spaces:
  root: docs/branch
numbering:
  width: 3
  unique: true
  candidate_selection: highest_changed_number
legacy:
  cutoff_commit: null
  automation_enabled: true
`);
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');

  const job: JobConfig = {
    id: 'workflow-watcher',
    type: 'workflow_watcher',
    schedule: '*/10 * * * *',
    enabled: true,
    mode: 'shadow',
    config: {
      contract_path: 'docs/workflow/workflow-contract.yaml',
      branch_space: 'main',
      initial_cursor_commit: base,
    },
  };
  const project: ProjectConfig = {
    id: 'example',
    name: 'Example',
    path: root,
    ref: 'refs/heads/main',
    feishu: { chat_id: 'must-not-send', approver_open_ids: ['approver'] },
    jobs: [job],
  };
  const run = (cursor?: unknown) => workflowWatcherHandler({
    project,
    job,
    mode: 'shadow',
    cursor,
    signal: new AbortController().signal,
  });

  assert.match((await run()).summary, /candidate=none/);
  await writeFile(path.join(root, 'docs/branch/main/001_PLAN_20260725_test.md'), `---
doc_type: PLAN
doc_status: ready
next_action: start_first_slice
---
`);
  git('add', '.');
  git('commit', '-qm', 'plan');
  const plan = await run();
  assert.match(plan.summary, /candidate=.*001_PLAN_20260725_test\.md type=PLAN action=start_first_slice gate=plan_review/);
  assert.equal(typeof (plan.cursor as { eventKey: string }).eventKey, 'string');

  await writeFile(path.join(root, 'docs/branch/main/002_HANDOVER_20260725_test.md'), `---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
---
`);
  git('add', '.');
  git('commit', '-qm', 'handover');
  const handover = await run(plan.cursor);
  assert.match(handover.summary, /type=HANDOVER action=next_slice gate=workflow_ready/);

  await assert.rejects(
    workflowWatcherHandler({
      project,
      job,
      mode: 'active',
      cursor: handover.cursor,
      signal: new AbortController().signal,
    }),
    /active mode is not enabled/,
  );
  console.log('workflow watcher checks passed');
}

void main();
