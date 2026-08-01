import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readWorkflowContract,
  validateWorkflowDocuments,
  WorkflowDocumentValidationError,
} from '../src/lib/scheduled-jobs/workflow-validator';

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
    (await readFile(path.join(process.cwd(), 'docs/workflow/workflow-contract.yaml'), 'utf8'))
      .replace('mode: balanced', 'mode: strict'),
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
  await assert.rejects(
    validateWorkflowDocuments({
      cwd: root,
      ref: 'refs/heads/missing-runtime-ref',
      contractRef: ref,
      filePaths: ['docs/001_PLAN_20260726_valid.md'],
    }),
    (error: Error) => !(error instanceof WorkflowDocumentValidationError),
    'Git/runtime failures must not be classified as document validation failures',
  );
  await assert.rejects(
    validateWorkflowDocuments({
      cwd: root,
      ref,
      filePaths: [
        'docs/002_PLAN_20260726_terminal_prompt.md',
        'docs/010_PLAN_20260726_missing_runtime_file.md',
      ],
    }),
    (error: Error) => error instanceof WorkflowDocumentValidationError,
    'a proven document failure must still fail closed when the same batch also has a runtime failure',
  );
  await assert.rejects(validate('docs/002_PLAN_20260726_terminal_prompt.md'), /无效的下一步动作/);
  await assert.rejects(validate('docs/003_PLAN_20260726_missing_prompt.md'), /必须包含且只能包含一对 Prompt 标记/);
  await assert.rejects(
    validate('docs/006_PLAN_20260726_all_errors.md'),
    (error: Error) => {
      assert.ok(error instanceof WorkflowDocumentValidationError);
      assert.match(error.message, /共发现 3 个工作流文档错误/);
      assert.match(error.message, /YAML\.plan_kind.*缺少必填字段/);
      assert.match(error.message, /Prompt.*必须包含且只能包含一对 Prompt 标记/);
      assert.match(error.message, /正文.*至少需要包含一个 Slice/);
      assert.deepEqual(error.issues.map(({ code, severity }) => [code, severity]), [
        ['PROMPT_MARKERS_INVALID', 'error'],
        ['PLAN_REQUIRED_FIELD_MISSING', 'error'],
        ['PLAN_SLICE_MISSING', 'error'],
      ]);
      assert.ok(error.issues.every(({ location, template }) => location && template.length < 200));
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

  const balancedContract = (await readFile(
    path.join(root, 'docs/workflow/workflow-contract.yaml'),
    'utf8',
  )).replace('mode: strict', 'mode: balanced');
  await writeFile(path.join(root, 'docs/workflow/workflow-contract.yaml'), balancedContract);
  git('add', '.');
  git('commit', '-qm', 'use balanced validation');
  const balancedRef = git('rev-parse', 'HEAD');
  const [balanced] = await validateWorkflowDocuments({
    cwd: root,
    ref: balancedRef,
    filePaths: ['docs/005_HANDOVER_20260726_invalid.md'],
  });
  assert.deepEqual(
    balanced.issues.filter(({ code }) => code !== 'TEMPLATE_MISSING').map(({ code, severity }) => [code, severity]),
    [
      ['PROMPT_DOCUMENT_REFERENCE_MISSING', 'warning'],
      ['PROMPT_DOCUMENT_REFERENCE_MISSING', 'warning'],
      ['PROMPT_DOCUMENT_REFERENCE_MISSING', 'warning'],
      ['NEXT_SLICE_MISSING', 'warning'],
    ],
  );
  assert.equal(balanced.issues.filter(({ code }) => code === 'TEMPLATE_MISSING').length, 2);
  await assert.rejects(
    validateWorkflowDocuments({
      cwd: root,
      ref: balancedRef,
      filePaths: ['docs/006_PLAN_20260726_all_errors.md'],
    }),
    (error: Error) => {
      assert.ok(error instanceof WorkflowDocumentValidationError);
      assert.match(error.message, /共发现 2 个工作流文档错误/);
      assert.equal(error.issues.find(({ code }) => code === 'PLAN_SLICE_MISSING')?.severity, 'warning');
      return true;
    },
    'balanced must not downgrade structural errors',
  );

  const relaxedContract = (await readFile(
    path.join(root, 'docs/workflow/workflow-contract.yaml'),
    'utf8',
  ))
    .replace('next_slice_must_exist: true', 'next_slice_must_exist: false')
    .replace('prompt_must_reference_documents: true', 'prompt_must_reference_documents: false');
  await writeFile(path.join(root, 'docs/workflow/workflow-contract.yaml'), relaxedContract);
  git('add', '.');
  git('commit', '-qm', 'relax configurable validation rules');
  await validateWorkflowDocuments({
    cwd: root,
    ref: git('rev-parse', 'HEAD'),
    filePaths: ['docs/005_HANDOVER_20260726_invalid.md'],
  });

  await writeFile(path.join(root, 'docs/002_PLAN_20260726_terminal_prompt.md'), plan('await_plan_approval'));
  await assert.rejects(
    validate('docs/002_PLAN_20260726_terminal_prompt.md'),
    /无效的下一步动作/,
    'validation must read the target ref, not the legal workspace copy',
  );

  const planTemplate = await readFile(path.join(process.cwd(), 'docs/workflow/templates/PLAN.md'), 'utf8');
  const handoverTemplate = await readFile(path.join(process.cwd(), 'docs/workflow/templates/HANDOVER.md'), 'utf8');
  for (const required of ['## Phase PLAN', '## Interrupt PLAN', 'start_first_slice']) {
    assert.match(planTemplate, new RegExp(required));
  }
  for (const required of ['## 继续下一 Slice', '## 恢复父 PLAN', '## 终止并等待验收', 'next_slice', 'resume_parent', 'await_acceptance']) {
    assert.match(handoverTemplate, new RegExp(required));
  }
  const block = (source: string, heading: string) => {
    const match = source.match(new RegExp(`## ${heading}\\n\\n\`\`\`markdown\\n([\\s\\S]*?)\\n\`\`\``));
    assert.ok(match, `missing template block: ${heading}`);
    return match[1];
  };
  await mkdir(path.join(root, 'docs/workflow/templates'), { recursive: true });
  await writeFile(path.join(root, 'docs/workflow/templates/PLAN.md'), planTemplate);
  await writeFile(path.join(root, 'docs/workflow/templates/HANDOVER.md'), handoverTemplate);
  await writeFile(
    path.join(root, 'docs/workflow/workflow-contract.yaml'),
    (await readFile(path.join(process.cwd(), 'docs/workflow/workflow-contract.yaml'), 'utf8'))
      .replace('mode: balanced', 'mode: strict'),
  );
  const phasePath = 'docs/011_PLAN_20260801_template.md';
  const interruptPath = 'docs/012_PLAN_20260801_interrupt.md';
  const nextPath = 'docs/013_HANDOVER_20260801_next.md';
  const resumePath = 'docs/014_HANDOVER_20260801_resume.md';
  const terminalPath = 'docs/015_HANDOVER_20260801_terminal.md';
  await writeFile(path.join(root, phasePath), block(planTemplate, 'Phase PLAN')
    .replaceAll('<编号>_PLAN_<日期>_<主题>', '011_PLAN_20260801_template')
    .replaceAll('<主题>', '模板验证')
    .replace('<首个 Slice>', '模板验证')
    .replace('<范围与完成标准>', '验证模板实例。'));
  await writeFile(path.join(root, interruptPath), block(planTemplate, 'Interrupt PLAN')
    .replaceAll('<编号>_PLAN_<日期>_<主题>', '012_PLAN_20260801_interrupt')
    .replaceAll('docs/<父PLAN>.md', 'docs/008_PLAN_20260726_no_roadmap.md')
    .replace('<阻塞修复主题>', '模板验证')
    .replace('<修复 Slice>', '模板验证')
    .replace('<范围与完成标准>', '验证模板实例。'));
  await writeFile(path.join(root, nextPath), block(handoverTemplate, '继续下一 Slice')
    .replaceAll('docs/<本HANDOVER>.md', nextPath)
    .replaceAll('docs/<PLAN>.md', 'docs/008_PLAN_20260726_no_roadmap.md')
    .replace('<S01 结果>', '模板验证')
    .replace('<完成内容、验证和遗留事项>', '验证模板实例。'));
  await writeFile(path.join(root, resumePath), block(handoverTemplate, '恢复父 PLAN')
    .replaceAll('docs/<本HANDOVER>.md', resumePath)
    .replaceAll('docs/<Interrupt-PLAN>.md', interruptPath)
    .replaceAll('docs/<父PLAN>.md', 'docs/008_PLAN_20260726_no_roadmap.md')
    .replace('<Interrupt PLAN 完成>', '模板验证')
    .replace('<完成内容与验证>', '验证模板实例。'));
  await writeFile(path.join(root, terminalPath), block(handoverTemplate, '终止并等待验收')
    .replaceAll('docs/<PLAN>.md', 'docs/008_PLAN_20260726_no_roadmap.md')
    .replace('slice: S01', 'slice: S02')
    .replace('<完成结果>', '模板验证')
    .replace('<完成内容、验证、验收入口和遗留事项>', '验证模板实例。'));
  git('add', '.');
  git('commit', '-qm', 'validate authoritative templates');
  const templateRef = git('rev-parse', 'HEAD');
  const templateResults = await validateWorkflowDocuments({
    cwd: root,
    ref: templateRef,
    filePaths: [phasePath, interruptPath, nextPath, resumePath, terminalPath],
  });
  assert.ok(templateResults.every(({ issues }) => issues.length === 0));
  console.log('workflow validator contract/ref checks passed');
}

void main();
