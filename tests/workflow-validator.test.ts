import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  GitRefReader,
  readWorkflowContract,
  validateWorkflowDocuments,
  WorkingTreeReader,
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
  await writeFile(
    path.join(root, 'docs/017_PLAN_20260726_multiple_prompts.md'),
    plan('start_first_slice', validPrompt + validPrompt),
  );
  await writeFile(
    path.join(root, 'docs/018_PLAN_20260726_half_prompt.md'),
    plan('start_first_slice', '<!-- WORKFLOW_PROMPT_START -->\n缺少结束标记。\n'),
  );
  await writeFile(
    path.join(root, 'docs/019_PLAN_20260726_terminal_prompt.md'),
    plan('await_acceptance', validPrompt),
  );
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

  const signal = new AbortController().signal;
  const gitReader = new GitRefReader(root, ref, signal);
  const workingTreeReader = new WorkingTreeReader(root, ref, signal);
  const [gitResult] = await validateWorkflowDocuments({
    cwd: root,
    ref,
    filePaths: ['docs/001_PLAN_20260726_valid.md'],
    reader: gitReader,
  });
  const [workingTreeResult] = await validateWorkflowDocuments({
    cwd: root,
    ref,
    filePaths: ['docs/001_PLAN_20260726_valid.md'],
    reader: workingTreeReader,
  });
  assert.deepEqual(workingTreeResult, gitResult);

  const fallbackPlanPath = path.join(root, 'docs/008_PLAN_20260726_no_roadmap.md');
  const fallbackPlan = await readFile(fallbackPlanPath, 'utf8');
  await unlink(fallbackPlanPath);
  await validateWorkflowDocuments({
    cwd: root,
    ref,
    filePaths: ['docs/009_HANDOVER_20260726_no_roadmap.md'],
    reader: workingTreeReader,
  });
  assert.equal(await workingTreeReader.read('docs/008_PLAN_20260726_no_roadmap.md'), fallbackPlan);
  await writeFile(fallbackPlanPath, fallbackPlan);

  await writeFile(path.join(root, 'docs/016_PLAN_20260812_preflight.md'), `---
doc_type: PLAN
doc_status: ready
next_action: start_first_slice
---
`);
  const cli = spawnSync(process.execPath, [
    '-r', require.resolve('ts-node/register/transpile-only'),
    path.join(process.cwd(), 'scripts/validate-workflow-documents.ts'),
    '--preflight', 'docs/016_PLAN_20260812_preflight.md', '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs","moduleResolution":"node"}',
    },
  });
  assert.equal(cli.status, 1, cli.stderr);
  const cliIssues = JSON.parse(cli.stdout) as Array<Record<string, unknown>>;
  assert.ok(cliIssues.length > 0);
  for (const field of ['code', 'severity', 'location', 'message', 'expected', 'actual', 'template']) {
    assert.ok(field in cliIssues[0], `preflight JSON issue missing ${field}`);
  }
  const missingMarkerIssue = cliIssues.find(({ code }) => code === 'PROMPT_MARKERS_MISSING');
  assert.equal(missingMarkerIssue?.actual, '检测到 0 个 start / 0 个 end 标记');
  assert.match(String(missingMarkerIssue?.template), /补齐缺失标记.*start 行：无；end 行：无/);
  const textCli = spawnSync(process.execPath, [
    '-r', require.resolve('ts-node/register/transpile-only'),
    path.join(process.cwd(), 'scripts/validate-workflow-documents.ts'),
    '--preflight', 'docs/016_PLAN_20260812_preflight.md',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs","moduleResolution":"node"}',
    },
  });
  assert.equal(textCli.status, 1);
  assert.match(textCli.stderr, /ERROR \[PROMPT_MARKERS_MISSING\] \[Prompt\]/);
  assert.match(textCli.stderr, /实际：检测到 0 个 start \/ 0 个 end 标记/);
  assert.match(textCli.stderr, /修复：补齐缺失标记.*start 行：无；end 行：无/);
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
  const markerIssue = async (filePath: string) => {
    try {
      await validate(filePath);
      assert.fail(`${filePath} should fail validation`);
    } catch (error) {
      assert.ok(error instanceof WorkflowDocumentValidationError);
      return error.issues.find(({ location }) => location === 'Prompt');
    }
  };
  assert.deepEqual(
    await markerIssue('docs/003_PLAN_20260726_missing_prompt.md'),
    {
      code: 'PROMPT_MARKERS_MISSING',
      severity: 'error',
      location: 'Prompt',
      message: '可执行动作缺少 Prompt 标记',
      expected: '恰好一对 Prompt 标记',
      actual: '检测到 0 个 start / 0 个 end 标记',
      template: '补齐缺失标记（start 行：无；end 行：无）',
    },
  );
  const multiple = await markerIssue('docs/017_PLAN_20260726_multiple_prompts.md');
  assert.equal(multiple?.code, 'PROMPT_MARKERS_INVALID');
  assert.equal(multiple?.message, '可执行动作的 Prompt 标记数量无效');
  assert.equal(multiple?.actual, '检测到 2 个 start / 2 个 end 标记');
  assert.match(multiple?.template ?? '', /删除多余标记，只保留一对.*start 行：9、12；end 行：11、14/);
  const half = await markerIssue('docs/018_PLAN_20260726_half_prompt.md');
  assert.equal(half?.code, 'PROMPT_MARKERS_MISSING');
  assert.equal(half?.actual, '检测到 1 个 start / 0 个 end 标记');
  assert.match(half?.template ?? '', /补齐缺失标记.*start 行：9；end 行：无/);
  const terminal = await markerIssue('docs/019_PLAN_20260726_terminal_prompt.md');
  assert.equal(terminal?.code, 'PROMPT_FORBIDDEN');
  assert.equal(terminal?.actual, '检测到 1 个 start / 1 个 end 标记');
  assert.match(terminal?.template ?? '', /删除所有 Prompt 标记及其内容.*start 行：9；end 行：11/);
  await assert.rejects(
    validate('docs/006_PLAN_20260726_all_errors.md'),
    (error: Error) => {
      assert.ok(error instanceof WorkflowDocumentValidationError);
      assert.match(error.message, /共发现 3 个工作流文档错误/);
      assert.match(error.message, /YAML\.plan_kind.*缺少必填字段/);
      assert.match(error.message, /Prompt.*可执行动作缺少 Prompt 标记.*检测到 0 个 start \/ 0 个 end 标记/);
      assert.match(error.message, /正文.*至少需要包含一个 Slice/);
      assert.deepEqual(error.issues.map(({ code, severity }) => [code, severity]), [
        ['PROMPT_MARKERS_MISSING', 'error'],
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

  // Commit-time numbering uniqueness (PLAN 418 S02): a second document reusing
  // an existing number in the same branch space is rejected with the existing
  // path; a different branch space restarts numbering (contract
  // `numbering.scope: branch_space`) and a fresh number passes.
  await writeFile(path.join(root, 'docs/001_HANDOVER_20260813_duplicate.md'), `---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: 001_PLAN_20260726_valid.md
slice: S01
plan_progress: complete
---
`);
  git('add', '.');
  git('commit', '-qm', 'duplicate number fixture');
  await assert.rejects(
    validateWorkflowDocuments({
      cwd: root,
      ref: git('rev-parse', 'HEAD'),
      filePaths: ['docs/001_HANDOVER_20260813_duplicate.md'],
    }),
    (error: Error) => {
      assert.ok(error instanceof WorkflowDocumentValidationError);
      assert.match(error.message, /编号 001 不唯一/);
      assert.match(error.message, /docs\/001_HANDOVER_20260813_duplicate\.md/);
      assert.match(error.message, /docs\/001_PLAN_20260726_valid\.md/);
      assert.equal(error.issues[0]?.code, 'DOCUMENT_NUMBER_DUPLICATE');
      assert.equal(error.issues[0]?.severity, 'error');
      return true;
    },
  );
  git('rm', '-q', 'docs/001_HANDOVER_20260813_duplicate.md');
  await mkdir(path.join(root, 'docs/021_branch'), { recursive: true });
  await writeFile(path.join(root, 'docs/021_branch/001_HANDOVER_20260813_branch_space.md'), `---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: null
slice: S01
plan_progress: complete
---
`);
  await writeFile(path.join(root, 'docs/022_PLAN_20260813_unique.md'), plan('start_first_slice', `<!-- WORKFLOW_PROMPT_START -->
执行 022_PLAN_20260813_unique.md 的 S01，遵循 000_ROADMAP_20260726_test.md。
<!-- WORKFLOW_PROMPT_END -->
`));
  git('add', '.');
  git('commit', '-qm', 'branch-space and unique number fixtures');
  await validateWorkflowDocuments({
    cwd: root,
    ref: git('rev-parse', 'HEAD'),
    filePaths: [
      'docs/021_branch/001_HANDOVER_20260813_branch_space.md',
      'docs/022_PLAN_20260813_unique.md',
    ],
  });
  console.log('workflow validator contract/ref checks passed');
}

void main();
