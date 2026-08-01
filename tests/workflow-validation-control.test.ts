import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canManageWorkflowValidation,
  formatWorkflowValidationStatus,
  formatWorkflowValidationTemplate,
  inspectWorkflowValidation,
  setWorkflowValidationMode,
  validateSelectedWorkflowDocument,
  workflowValidationRepairKey,
} from '../src/lib/feishu-workflow-validation';
import type { JobConfig, ProjectConfig, ProjectsConfig } from '../src/lib/scheduled-jobs/project-config';

const root = mkdtempSync(path.join(os.tmpdir(), 'workflow-validation-control-'));
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]).toString().trim();
const write = (file: string, content: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
};

const job: JobConfig = {
  id: 'workflow-watcher',
  type: 'workflow_watcher',
  schedule: '* * * * *',
  enabled: true,
  mode: 'active',
  config: { contract_path: 'docs/workflow/workflow-contract.yaml' },
};
const project: ProjectConfig = {
  id: 'project',
  name: 'Project',
  path: root,
  ref: 'refs/heads/main',
  feishu: { chat_id: 'chat', approver_open_ids: ['approver'] },
  jobs: [job],
};
const config: ProjectsConfig = { projects: [project] };

async function main() {
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    write(
      'docs/workflow/workflow-contract.yaml',
      readFileSync(path.join(process.cwd(), 'docs/workflow/workflow-contract.yaml'), 'utf8').replace('mode: balanced', 'mode: strict'),
    );
    write('docs/001_PLAN_20260801_invalid.md', [
      '---',
      'doc_type: PLAN',
      'doc_status: ready',
      'next_action: start_first_slice',
      'plan_kind: phase',
      'roadmap: null',
      'parent_plan: docs/parent.md',
      'parent_slice: null',
      'return_to: null',
      '---',
      '',
      '# Missing Slice',
      '',
      '<!-- WORKFLOW_PROMPT_START -->',
      'Run docs/001_PLAN_20260801_invalid.md S01.',
      '<!-- WORKFLOW_PROMPT_END -->',
      '',
    ].join('\n'));
    git('add', '.');
    git('commit', '-qm', 'initial');
    const initial = git('rev-parse', 'HEAD');
    const blob = git('rev-parse', `${initial}:docs/001_PLAN_20260801_invalid.md`);

    const inspection = await inspectWorkflowValidation(project, job, {
      validationFailure: { path: 'docs/001_PLAN_20260801_invalid.md', blob },
    });
    assert(inspection.issues.some(({ code, severity }) => code === 'PHASE_PARENT_FIELDS_NON_NULL' && severity === 'error'));
    assert.match(formatWorkflowValidationStatus(inspection), /strict[\s\S]*error 1/);
    assert.match(formatWorkflowValidationTemplate(inspection), /parent_plan: <值>/);
    assert.match(await validateSelectedWorkflowDocument({
      project,
      job,
      documentPath: 'docs/001_PLAN_20260801_invalid.md',
      expectedHead: initial,
    }), /❌ 未通过[\s\S]*Git HEAD[\s\S]*修复示例/);
    assert.equal(
      workflowValidationRepairKey({ path: 'docs/001_PLAN_20260801_invalid.md', blob }),
      `validation-repair:docs/001_PLAN_20260801_invalid.md:${blob}`,
    );

    const updated = await setWorkflowValidationMode({
      config, project, job, expectedHead: initial, mode: 'balanced',
    });
    assert.equal(updated.state, 'updated');
    assert.match(git('show', 'HEAD:docs/workflow/workflow-contract.yaml'), /mode: balanced/);
    const commitCount = git('rev-list', '--count', 'HEAD');
    const unchanged = await setWorkflowValidationMode({
      config, project, job, expectedHead: updated.head, mode: 'balanced',
    });
    assert.equal(unchanged.state, 'unchanged');
    assert.equal(git('rev-list', '--count', 'HEAD'), commitCount);
    assert.equal((await setWorkflowValidationMode({
      config, project, job, expectedHead: initial, mode: 'strict',
    })).state, 'stale');

    write('dirty.txt', 'dirty');
    await assert.rejects(() => setWorkflowValidationMode({
      config, project, job, expectedHead: updated.head, mode: 'strict',
    }), /非 clean/);
    rmSync(path.join(root, 'dirty.txt'));
    await assert.rejects(() => setWorkflowValidationMode({
      config: { projects: [project, { ...project, id: 'duplicate', feishu: { chat_id: 'other', approver_open_ids: [] } }] },
      project,
      job,
      expectedHead: updated.head,
      mode: 'strict',
    }), /多个 workflow consumer/);

    assert(canManageWorkflowValidation('admin', true, []));
    assert(canManageWorkflowValidation('approver', false, ['approver']));
    assert(!canManageWorkflowValidation('member', false, ['approver']));
    console.log('workflow validation control checks passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
