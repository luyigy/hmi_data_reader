import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertWorkflowCompletion,
  getWorkflowCompletionBaseline,
  shouldCheckWorkflowCompletion,
} from '../src/lib/acpx/workflow-completion-gate';

async function main() {
  assert.equal(shouldCheckWorkflowCompletion(undefined, 'platform_local'), false);
  assert.equal(shouldCheckWorkflowCompletion(false, 'platform_local'), false);
  assert.equal(shouldCheckWorkflowCompletion(true, 'gateway_openclaw'), false);
  assert.equal(shouldCheckWorkflowCompletion(true, 'platform_local'), true);

  const plainRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-completion-gate-plain-'));
  const plainGit = (...args: string[]) => execFileSync('git', ['-C', plainRoot, ...args]).toString().trim();
  plainGit('init', '-q', '-b', 'main');
  plainGit('config', 'user.email', 'test@example.com');
  plainGit('config', 'user.name', 'Test');
  await writeFile(path.join(plainRoot, 'README.md'), '# plain repo\n');
  plainGit('add', '.');
  plainGit('commit', '-qm', 'baseline');
  await assertWorkflowCompletion(plainRoot, await getWorkflowCompletionBaseline(plainRoot));

  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-completion-gate-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await mkdir(path.join(root, 'docs/workflow'), { recursive: true });
  await writeFile(
    path.join(root, 'docs/workflow/workflow-contract.yaml'),
    await readFile(path.join(process.cwd(), 'docs/workflow/workflow-contract.yaml')),
  );
  await writeFile(path.join(root, 'docs/000_ROADMAP_20260726_test.md'), '# roadmap\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const baseline = await getWorkflowCompletionBaseline(root);

  await assertWorkflowCompletion(root, baseline);

  const plan = (action: string) => `---
doc_type: PLAN
doc_status: ${action === 'start_first_slice' ? 'ready' : 'draft'}
next_action: ${action}
plan_kind: phase
roadmap: 000_ROADMAP_20260726_test.md
parent_plan: null
parent_slice: null
return_to: null
---
S01
<!-- WORKFLOW_PROMPT_START -->
执行 001_PLAN_20260726_test.md 的 S01，遵循 000_ROADMAP_20260726_test.md。
<!-- WORKFLOW_PROMPT_END -->
`;
  const planPath = path.join(root, 'docs/001_PLAN_20260726_test.md');
  await writeFile(planPath, plan('start_first_slice'));
  await assert.rejects(
    assertWorkflowCompletion(root, baseline),
    /uncommitted workflow document.*001_PLAN_20260726_test\.md/,
  );

  const preDirtyBaseline = await getWorkflowCompletionBaseline(root);
  await assertWorkflowCompletion(root, preDirtyBaseline);
  await writeFile(planPath, `${plan('start_first_slice')}\nchanged during run\n`);
  await assert.rejects(
    assertWorkflowCompletion(root, preDirtyBaseline),
    /uncommitted workflow document.*001_PLAN_20260726_test\.md/,
  );

  git('add', '.');
  git('commit', '-qm', 'valid plan');
  await assertWorkflowCompletion(root, baseline);

  const validHead = await getWorkflowCompletionBaseline(root);
  await writeFile(planPath, plan('await_plan_approval'));
  git('add', '.');
  git('commit', '-qm', 'invalid plan');
  await assert.rejects(
    assertWorkflowCompletion(root, validHead),
    /workflow completion blocked:[\s\S]*非可执行动作不得包含自动化 Prompt/,
  );

  console.log('workflow completion gate checks passed');
}

void main();
