import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkflowDocument } from '../scripts/new-workflow-document';
import { validateWorkflowDocuments, WorkingTreeReader } from '../src/lib/scheduled-jobs/workflow-validator';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-scaffold-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await mkdir(path.join(root, 'docs/workflow/templates'), { recursive: true });
  for (const file of ['workflow-contract.yaml', 'PLAN-writing-standard.md', 'templates/PLAN.md', 'templates/HANDOVER.md']) {
    await writeFile(path.join(root, 'docs/workflow', file), await readFile(path.join(process.cwd(), 'docs/workflow', file)));
  }
  await writeFile(path.join(root, 'docs/007_REPORT_20260812_existing.md'), '# existing\n');
  await writeFile(path.join(root, 'docs/012_REPORT_20260812_ref_only.md'), '# ref only\n');
  await writeFile(path.join(root, 'docs/008_PLAN_20260812_fixture.md'), `---
doc_type: PLAN
doc_status: ready
next_action: start_first_slice
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · fixture

## S01：first

## S02：last

<!-- WORKFLOW_PROMPT_START -->
执行 docs/008_PLAN_20260812_fixture.md 的 S01。
<!-- WORKFLOW_PROMPT_END -->
`);
  git('add', '.');
  git('commit', '-qm', 'fixtures');
  await unlink(path.join(root, 'docs/012_REPORT_20260812_ref_only.md'));

  const phase = await createWorkflowDocument(root, ['--kind', 'plan', '--title', '新计划']);
  assert.match(phase.filePath, /^docs\/013_PLAN_\d{8}_新计划\.md$/);
  const phaseContent = await readFile(path.join(root, phase.filePath), 'utf8');
  assert.match(phaseContent, /plan_kind: phase/);
  assert.match(phaseContent, /next_action: await_approval/);

  const next = await createWorkflowDocument(root, [
    '--kind', 'handover', '--plan', 'docs/008_PLAN_20260812_fixture.md', '--slice', 'S01',
  ]);
  const nextContent = await readFile(path.join(root, next.filePath), 'utf8');
  assert.match(next.filePath, /^docs\/014_HANDOVER_\d{8}_S01交付\.md$/);
  assert.match(nextContent, /next_action: next_slice/);
  assert.match(nextContent, /plan_progress: in_progress/);
  assert.equal(nextContent.match(/<!-- WORKFLOW_PROMPT_START -->/g)?.length, 1);
  assert.match(nextContent, /只执行 S02/);

  const terminal = await createWorkflowDocument(root, [
    '--kind', 'handover', '--plan', 'docs/008_PLAN_20260812_fixture.md', '--slice', 'S02',
  ]);
  const terminalContent = await readFile(path.join(root, terminal.filePath), 'utf8');
  assert.match(terminal.filePath, /^docs\/015_HANDOVER_\d{8}_S02完成\.md$/);
  assert.match(terminalContent, /next_action: await_acceptance/);
  assert.match(terminalContent, /plan_progress: complete/);
  assert.doesNotMatch(terminalContent, /WORKFLOW_PROMPT/);

  const interrupt = await createWorkflowDocument(root, [
    '--kind', 'plan', '--title', '中断计划', '--plan-kind', 'interrupt',
    '--parent-plan', 'docs/008_PLAN_20260812_fixture.md', '--parent-slice', 'S01', '--return-to', 'S02',
  ]);
  const interruptContent = await readFile(path.join(root, interrupt.filePath), 'utf8');
  assert.match(interruptContent, /plan_kind: interrupt/);
  assert.match(interruptContent, /parent_plan: docs\/008_PLAN_20260812_fixture\.md/);
  assert.match(interruptContent, /parent_slice: S01/);
  assert.match(interruptContent, /return_to: S02/);

  const reader = new WorkingTreeReader(root);
  for (const filePath of [phase.filePath, next.filePath, terminal.filePath, interrupt.filePath]) {
    await validateWorkflowDocuments({ cwd: root, ref: 'HEAD', filePaths: [filePath], reader });
  }
  console.log('workflow scaffold checks passed');
}

void main();
