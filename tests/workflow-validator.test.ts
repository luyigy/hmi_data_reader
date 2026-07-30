import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readWorkflowContract, validateWorkflowDocuments } from '../src/lib/scheduled-jobs/workflow-validator';

async function main() {
  const legacyRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-validator-legacy-'));
  const legacyGit = (...args: string[]) => execFileSync('git', ['-C', legacyRoot, ...args]).toString().trim();
  legacyGit('init', '-q', '-b', 'main');
  legacyGit('config', 'user.email', 'test@example.com');
  legacyGit('config', 'user.name', 'Test');
  await mkdir(path.join(legacyRoot, 'docs/workflow'), { recursive: true });
  const currentContract = (await readFile(path.join(process.cwd(), 'docs/workflow/workflow-contract.yaml'), 'utf8'))
    .replace('slice_pattern: "\\\\bS[0-9]{2,}\\\\b"', 'slice_pattern: "(?m)\\\\bS[0-9]{2,}\\\\b"');
  await writeFile(
    path.join(legacyRoot, 'docs/workflow/workflow-contract.yaml'),
    currentContract.replace(
      /    required_fields_by_kind:\n      interrupt:\n(?:        - .+\n)+/,
      '',
    ),
  );
  legacyGit('add', '.');
  legacyGit('commit', '-qm', 'legacy contract');
  const legacyContract = await readWorkflowContract(
    legacyRoot,
    legacyGit('rev-parse', 'HEAD'),
    'docs/workflow/workflow-contract.yaml',
    new AbortController().signal,
  );
  assert.deepEqual(legacyContract.documents.plan.required_fields_by_kind, {});

  const headingRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-validator-heading-'));
  const headingGit = (...args: string[]) => execFileSync('git', ['-C', headingRoot, ...args]).toString().trim();
  headingGit('init', '-q', '-b', 'main');
  headingGit('config', 'user.email', 'test@example.com');
  headingGit('config', 'user.name', 'Test');
  await mkdir(path.join(headingRoot, 'docs/workflow'), { recursive: true });
  await writeFile(path.join(headingRoot, 'docs/workflow/workflow-contract.yaml'),
    (await readFile(path.join(process.cwd(), 'docs/workflow/workflow-contract.yaml'), 'utf8'))
      .replace('slice_pattern: "\\\\bS[0-9]{2,}\\\\b"', 'slice_pattern: "(?m)^\\\\s*#{2,4}\\\\s+\\\\d+\\\\.?\\\\s+(S[0-9]{2,})\\\\b"'),
  );
  await writeFile(path.join(headingRoot, 'docs/000_ROADMAP_20260726_test.md'), '# roadmap\n');
  await writeFile(path.join(headingRoot, 'docs/001_PLAN_20260726_heading.md'), `---
doc_type: PLAN
doc_status: ready
next_action: start_first_slice
plan_kind: phase
roadmap: 000_ROADMAP_20260726_test.md
parent_plan: null
parent_slice: null
return_to: null
---
## 4. S01
<!-- WORKFLOW_PROMPT_START -->
执行 001_PLAN_20260726_heading.md 的 S01，遵循 000_ROADMAP_20260726_test.md。
<!-- WORKFLOW_PROMPT_END -->
`);
  headingGit('add', '.');
  headingGit('commit', '-qm', 'heading fixture');
  await validateWorkflowDocuments({
    cwd: headingRoot,
    ref: headingGit('rev-parse', 'HEAD'),
    filePaths: ['docs/001_PLAN_20260726_heading.md'],
  });

  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-validator-'));
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

  const plan = (action: string, prompt = '') => `---
doc_type: PLAN
doc_status: ${action === 'start_first_slice' ? 'ready' : 'draft'}
next_action: ${action}
plan_kind: phase
roadmap: 000_ROADMAP_20260726_test.md
---
S01
${prompt}`;
  const validPrompt = `<!-- WORKFLOW_PROMPT_START -->
执行 001_PLAN_20260726_valid.md 的 S01，遵循 000_ROADMAP_20260726_test.md。
<!-- WORKFLOW_PROMPT_END -->
`;
  await writeFile(path.join(root, 'docs/001_PLAN_20260726_valid.md'), plan('start_first_slice', validPrompt));
  await writeFile(path.join(root, 'docs/002_PLAN_20260726_terminal_prompt.md'), plan('await_plan_approval', validPrompt));
  await writeFile(path.join(root, 'docs/003_PLAN_20260726_missing_prompt.md'), plan('start_first_slice'));
  await writeFile(path.join(root, 'docs/006_PLAN_20260726_all_errors.md'), `---
doc_type: PLAN
doc_status: ready
next_action: start_first_slice
---
`);
  await writeFile(path.join(root, 'docs/004_HANDOVER_20260726_valid.md'), `---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: 001_PLAN_20260726_valid.md
slice: S01
plan_progress: complete
---
`);
  await writeFile(path.join(root, 'docs/005_HANDOVER_20260726_invalid.md'), `---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: 001_PLAN_20260726_valid.md
slice: S01
plan_progress: complete
---
<!-- WORKFLOW_PROMPT_START -->
再次执行 S01。
<!-- WORKFLOW_PROMPT_END -->
`);
  await writeFile(path.join(root, 'docs/008_PLAN_20260726_no_roadmap.md'), `---
doc_type: PLAN
doc_status: ready
next_action: start_first_slice
plan_kind: phase
---
S01
S02
<!-- WORKFLOW_PROMPT_START -->
执行 008_PLAN_20260726_no_roadmap.md 的 S01。
<!-- WORKFLOW_PROMPT_END -->
`);
  await writeFile(path.join(root, 'docs/009_HANDOVER_20260726_no_roadmap.md'), `---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: 008_PLAN_20260726_no_roadmap.md
slice: S01
plan_progress: in_progress
---
<!-- WORKFLOW_PROMPT_START -->
读取 009_HANDOVER_20260726_no_roadmap.md 和 008_PLAN_20260726_no_roadmap.md，执行 S02。
<!-- WORKFLOW_PROMPT_END -->
`);
  git('add', '.');
  git('commit', '-qm', 'fixtures');
  const ref = git('rev-parse', 'HEAD');
  const validate = (filePath: string) => validateWorkflowDocuments({ cwd: root, ref, filePaths: [filePath] });

  await validate('docs/001_PLAN_20260726_valid.md');
  await validate('docs/004_HANDOVER_20260726_valid.md');
  await validate('docs/009_HANDOVER_20260726_no_roadmap.md');
  await assert.rejects(validate('docs/002_PLAN_20260726_terminal_prompt.md'), /非可执行动作不得包含自动化 Prompt/);
  await assert.rejects(validate('docs/003_PLAN_20260726_missing_prompt.md'), /必须包含且只能包含一对 Prompt 标记/);
  await assert.rejects(
    validate('docs/006_PLAN_20260726_all_errors.md'),
    (error: Error) => {
      assert.match(error.message, /共发现 3 个工作流文档错误/);
      assert.match(error.message, /YAML\.plan_kind.*缺少必填字段/);
      assert.match(error.message, /Prompt.*必须包含且只能包含一对 Prompt 标记/);
      assert.match(error.message, /正文.*至少需要包含一个 Slice/);
      return true;
    },
  );
  await writeFile(path.join(root, 'docs/007_PLAN_20260726_interrupt.md'), `---
doc_type: PLAN
doc_status: draft
next_action: await_plan_approval
plan_kind: interrupt
---
S01
`);
  git('add', '.');
  git('commit', '-qm', 'interrupt fixture');
  const interruptRef = git('rev-parse', 'HEAD');
  await assert.rejects(
    validateWorkflowDocuments({
      cwd: root,
      ref: interruptRef,
      filePaths: ['docs/007_PLAN_20260726_interrupt.md'],
    }),
    (error: Error) => {
      for (const field of ['parent_plan', 'parent_slice', 'return_to']) {
        assert.match(error.message, new RegExp(`YAML\\.${field}.*缺少必填字段`));
      }
      return true;
    },
  );
  await writeFile(path.join(root, 'docs/010_PLAN_20260726_bad_return.md'), `---
doc_type: PLAN
doc_status: draft
next_action: await_plan_approval
plan_kind: interrupt
parent_plan: 008_PLAN_20260726_no_roadmap.md
parent_slice: S01
return_to: 008_PLAN_20260726_no_roadmap.md#S02
---
S01
`);
  git('add', '.');
  git('commit', '-qm', 'invalid interrupt return fixture');
  await assert.rejects(
    validateWorkflowDocuments({
      cwd: root,
      ref: git('rev-parse', 'HEAD'),
      filePaths: ['docs/010_PLAN_20260726_bad_return.md'],
    }),
    (error: Error) => {
      assert.doesNotMatch(error.message, /YAML\.parent_slice/);
      assert.match(
        error.message,
        /YAML\.return_to.*父 PLAN 中不存在 return_to.*期望：S01、S02.*实际："008_PLAN_20260726_no_roadmap\.md#S02"/,
      );
      return true;
    },
  );
  await assert.rejects(
    validate('docs/005_HANDOVER_20260726_invalid.md'),
    (error: Error) => {
      assert.match(error.message, /共发现 4 个工作流文档错误/);
      assert.match(error.message, /缺少文档引用 005_HANDOVER_20260726_invalid\.md/);
      assert.match(error.message, /缺少文档引用 001_PLAN_20260726_valid\.md/);
      assert.match(error.message, /缺少文档引用 000_ROADMAP_20260726_test\.md/);
      assert.match(error.message, /S01 之后没有下一个 Slice/);
      assert.match(error.message, /改用终止动作/);
      assert.match(error.message, /由平台 completion gate 重新校验/);
      assert.doesNotMatch(error.message, /npm run workflow:validate/);
      return true;
    },
  );

  await writeFile(path.join(root, 'docs/002_PLAN_20260726_terminal_prompt.md'), plan('await_plan_approval'));
  await assert.rejects(
    validate('docs/002_PLAN_20260726_terminal_prompt.md'),
    /非可执行动作不得包含自动化 Prompt/,
    'validation must read the target ref, not the legal workspace copy',
  );
  console.log('workflow validator contract/ref checks passed');
}

void main();
