import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateWorkflowDocuments } from '../src/lib/scheduled-jobs/workflow-validator';

async function main() {
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
parent_plan: null
parent_slice: null
return_to: null
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
  git('add', '.');
  git('commit', '-qm', 'fixtures');
  const ref = git('rev-parse', 'HEAD');
  const validate = (filePath: string) => validateWorkflowDocuments({ cwd: root, ref, filePaths: [filePath] });

  await validate('docs/001_PLAN_20260726_valid.md');
  await validate('docs/004_HANDOVER_20260726_valid.md');
  await assert.rejects(validate('docs/002_PLAN_20260726_terminal_prompt.md'), /非可执行动作不得包含自动化 Prompt/);
  await assert.rejects(validate('docs/003_PLAN_20260726_missing_prompt.md'), /必须包含且只能包含一对 Prompt 标记/);
  await assert.rejects(
    validate('docs/006_PLAN_20260726_all_errors.md'),
    (error: Error) => {
      assert.match(error.message, /共发现 7 个工作流文档错误/);
      for (const field of ['plan_kind', 'roadmap', 'parent_plan', 'parent_slice', 'return_to']) {
        assert.match(error.message, new RegExp(`YAML\\.${field}.*缺少必填字段`));
      }
      assert.match(error.message, /Prompt.*必须包含且只能包含一对 Prompt 标记/);
      assert.match(error.message, /正文.*至少需要包含一个 Slice/);
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
      assert.match(error.message, /修复后先校验：npm run workflow:validate/);
      assert.match(error.message, /校验通过并提交后，在飞书发送：\/ap job run workflow-watcher/);
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
