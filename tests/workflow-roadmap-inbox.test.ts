import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseFeishuCommand } from '../src/lib/feishu-command-parser';
import {
  addWorkflowInboxIssue,
  canManageWorkflowInbox,
  validateWorkflowInboxInput,
} from '../src/lib/feishu-workflow-inbox';
import type { JobConfig, ProjectConfig, ProjectsConfig } from '../src/lib/scheduled-jobs/project-config';
import {
  proposeNextWorkflowInboxPlan,
} from '../src/lib/scheduled-jobs/workflow-roadmap-inbox';
import {
  readWorkflowContract,
  validateWorkflowDocuments,
} from '../src/lib/scheduled-jobs/workflow-validator';
import { workflowWatcherHandler } from '../src/lib/scheduled-jobs/workflow-watcher';

const signal = new AbortController().signal;
let fixtureNumber = 0;

const fixture = async () => {
  fixtureNumber += 1;
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-inbox-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await mkdir(path.join(root, 'docs/workflow'), { recursive: true });
  await writeFile(
    path.join(root, 'docs/workflow/workflow-contract.yaml'),
    (await readFile(path.join(process.cwd(), 'docs/workflow/workflow-contract.yaml'), 'utf8'))
      .replace(/cutoff_commit: ".+"/, 'cutoff_commit: null'),
  );
  await writeFile(path.join(root, 'docs/001_PLAN_20260731_owner.md'), `---
doc_type: PLAN
doc_status: in_progress
next_action: none
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---
# Owner
## S01
`);
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const job: JobConfig = {
    id: 'workflow-watcher',
    type: 'workflow_watcher',
    schedule: '* * * * *',
    enabled: true,
    mode: 'active',
    config: {
      active_side_effects_enabled: true,
      coding_bot_chat_id: 'coding',
      coding_bot_chat_type: 'group',
      contract_path: 'docs/workflow/workflow-contract.yaml',
      branch_space: '.',
      initial_cursor_commit: base,
      workflow_autonomy: 'auto',
      execution_policy: { preset: 'workspace' },
    },
  };
  const project: ProjectConfig = {
    id: `project-${fixtureNumber}`,
    name: 'Project',
    path: root,
    ref: 'refs/heads/main',
    feishu: { chat_id: 'chat', approver_open_ids: ['approver'] },
    jobs: [job],
  };
  const projects: ProjectsConfig = { projects: [project] };
  return { root, git, base, job, project, projects };
};

const main = async () => {
  process.env.FEISHU_APP_ID = 'test-app';
  process.env.FEISHU_APP_SECRET = 'test-secret';
  global.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if ('app_id' in body) {
      return { ok: true, status: 200, json: async () => ({ code: 0, tenant_access_token: 'token', expire: 3600 }) };
    }
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { message_id: 'message' } }) };
  }) as typeof fetch;

  assert.deepEqual(parseFeishuCommand({
    chatId: 'chat', chatType: 'p2p', messageId: 'message', senderOpenId: 'approver',
    messageType: 'text', text: '/ap inbox add "审计导出" --body="只导出 CSV" --head=0123456789012345678901234567890123456789',
    mentions: [], mentionNames: [],
  }), {
    command: 'inbox',
    args: ['add', '审计导出'],
    options: { body: '只导出 CSV', head: '0123456789012345678901234567890123456789' },
  });
  assert(canManageWorkflowInbox('approver', false, ['approver']));
  assert(canManageWorkflowInbox('admin', true, []));
  assert(!canManageWorkflowInbox('member', false, ['approver']));
  assert.throws(() => validateWorkflowInboxInput('../escape'), /路径字符/);
  assert.throws(() => validateWorkflowInboxInput('bad\u0000title'), /控制字符/);
  assert.throws(() => validateWorkflowInboxInput('secret', 'token=actual-value'), /敏感值/);
  assert.throws(() => validateWorkflowInboxInput('x'.repeat(121)), /1–120/);
  assert.throws(() => validateWorkflowInboxInput('valid', 'x'.repeat(4001)), /4000/);

  const command = await fixture();
  try {
    const created = await addWorkflowInboxIssue({
      config: command.projects,
      project: command.project,
      job: command.job,
      expectedHead: command.base,
      title: '审计导出',
      body: '只导出 CSV；`rm -rf` 仅作为文本保存。',
      requestId: 'message-1',
      now: new Date('2026-08-01T00:00:00Z'),
    });
    assert.equal(created.state, 'created');
    if (created.state !== 'created') throw new Error('expected created inbox issue');
    assert.match(created.path, /^docs\/inbox\/002_ISSUE_20260801_/);
    const content = command.git('show', `${created.head}:${created.path}`);
    assert.match(content, /doc_type: ISSUE\ndoc_status: draft\nnext_action: none/);
    assert.match(content, /`rm -rf` 仅作为文本保存/);
    assert.match(content, /WORKFLOW_INBOX_REQUEST/);
    assert.match(content, /WORKFLOW_INBOX_CONTENT/);
    assert.equal(command.git('-c', 'core.quotepath=false', 'show', '--format=', '--name-only', created.head), created.path);

    const repeatedMessage = await addWorkflowInboxIssue({
      config: command.projects,
      project: command.project,
      job: command.job,
      expectedHead: command.base,
      title: '审计导出',
      body: '只导出 CSV；`rm -rf` 仅作为文本保存。',
      requestId: 'message-1',
    });
    assert.equal(repeatedMessage.state, 'existing');
    const repeatedContent = await addWorkflowInboxIssue({
      config: command.projects,
      project: command.project,
      job: command.job,
      expectedHead: created.head,
      title: '审计导出',
      body: '只导出 CSV；`rm -rf` 仅作为文本保存。',
      requestId: 'message-2',
    });
    assert.equal(repeatedContent.state, 'existing');
    assert.equal((await addWorkflowInboxIssue({
      config: command.projects,
      project: command.project,
      job: command.job,
      expectedHead: command.base,
      title: '另一项需求',
      requestId: 'message-3',
    })).state, 'stale');

    await assert.rejects(addWorkflowInboxIssue({
      config: { projects: [command.project, { ...command.project, id: 'duplicate' }] },
      project: command.project,
      job: command.job,
      expectedHead: created.head,
      title: '唯一 consumer',
      requestId: 'message-4',
    }), /consumer 不唯一/);
    await writeFile(path.join(command.root, 'user-change.txt'), 'keep\n');
    await assert.rejects(addWorkflowInboxIssue({
      config: command.projects,
      project: command.project,
      job: command.job,
      expectedHead: created.head,
      title: 'dirty 检查',
      requestId: 'message-5',
    }), /非 clean/);
    await rm(path.join(command.root, 'user-change.txt'));

    command.git('checkout', '-qb', 'conflict-side');
    await writeFile(path.join(command.root, 'conflict.txt'), 'side\n');
    command.git('add', 'conflict.txt');
    command.git('commit', '-qm', 'side');
    command.git('checkout', '-q', 'main');
    await writeFile(path.join(command.root, 'conflict.txt'), 'main\n');
    command.git('add', 'conflict.txt');
    command.git('commit', '-qm', 'main');
    const conflictHead = command.git('rev-parse', 'HEAD');
    assert.throws(() => command.git('merge', 'conflict-side'), /CONFLICT|conflict/i);
    await assert.rejects(addWorkflowInboxIssue({
      config: command.projects,
      project: command.project,
      job: command.job,
      expectedHead: conflictHead,
      title: 'conflict 检查',
      requestId: 'message-6',
    }), /存在冲突/);
  } finally {
    await rm(command.root, { recursive: true, force: true });
  }

  const first = await fixture();
  try {
    const contract = await readWorkflowContract(
      first.root,
      first.base,
      'docs/workflow/workflow-contract.yaml',
      signal,
    );
    const args = {
      project: first.project,
      job: first.job,
      projects: first.projects,
      head: first.base,
      watchRoot: 'docs',
      contract,
      handoverMetadata: { plan: 'docs/001_PLAN_20260731_owner.md' },
      signal,
    };
    assert.equal((await proposeNextWorkflowInboxPlan(args)).status, 'no_source');

    await mkdir(path.join(first.root, 'docs/inbox'));
    await writeFile(path.join(first.root, 'docs/inbox/README.md'), '# Inbox\n');
    first.git('add', '.');
    first.git('commit', '-qm', 'add empty inbox');
    const emptyInboxHead = first.git('rev-parse', 'HEAD');
    const emptyInbox = await proposeNextWorkflowInboxPlan({ ...args, head: emptyInboxHead });
    assert.equal(emptyInbox.status, 'no_source');
    if (emptyInbox.status === 'no_source') assert.match(emptyInbox.reason, /no committed item/);

    await writeFile(path.join(first.root, 'docs/inbox/idea.md'), '# Add audit export\n\nKeep it small.\n');
    first.git('add', '.');
    first.git('commit', '-qm', 'add inbox item');
    const inboxHead = first.git('rev-parse', 'HEAD');
    await writeFile(path.join(first.root, 'user-change.txt'), 'keep staged\n');
    first.git('add', 'user-change.txt');
    const created = await proposeNextWorkflowInboxPlan({ ...args, head: inboxHead });
    assert.equal(created.status, 'created');
    if (created.status !== 'created') throw new Error('expected created proposal');
    assert.match(created.eventKey, /^workflow-inbox:/);
    const proposedHead = first.git('rev-parse', 'HEAD');
    const content = first.git('show', `${proposedHead}:${created.planPath}`);
    assert.match(content, /doc_status: ready/);
    assert.match(content, /next_action: await_approval/);
    assert.match(content, /WORKFLOW_INBOX_ITEM/);
    assert.match(content, new RegExp(inboxHead));
    assert.equal(first.git('diff', '--cached', '--name-only'), 'user-change.txt');
    assert.doesNotMatch(first.git('show', '--format=', '--name-only', 'HEAD'), /user-change/);
    await validateWorkflowDocuments({
      cwd: first.root,
      ref: proposedHead,
      filePaths: [created.planPath],
    });
    assert.equal((await proposeNextWorkflowInboxPlan({ ...args, head: proposedHead })).status, 'exhausted');
    assert.equal((await proposeNextWorkflowInboxPlan({ ...args, head: inboxHead })).status, 'stale');

    const otherProject = {
      ...first.project,
      id: 'other',
      feishu: { chat_id: 'other-chat', approver_open_ids: ['approver'] },
    };
    assert.equal((await proposeNextWorkflowInboxPlan({
      ...args,
      head: proposedHead,
      projects: { projects: [first.project, otherProject] },
    })).status, 'conflict');
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }

  const roadmap = await fixture();
  try {
    await writeFile(path.join(roadmap.root, 'docs/roadmap.md'), [
      '# Roadmap',
      '',
      '- [x] Completed item',
      '- [ ] First unclaimed item',
      '- [ ] Later item',
      '',
    ].join('\n'));
    await writeFile(path.join(roadmap.root, 'docs/001_PLAN_20260731_owner.md'), `---
doc_type: PLAN
doc_status: in_progress
next_action: none
plan_kind: phase
roadmap: docs/roadmap.md
parent_plan: null
parent_slice: null
return_to: null
---
# Owner
## S01
`);
    roadmap.git('add', '.');
    roadmap.git('commit', '-qm', 'associate roadmap');
    const head = roadmap.git('rev-parse', 'HEAD');
    const contract = await readWorkflowContract(
      roadmap.root,
      head,
      'docs/workflow/workflow-contract.yaml',
      signal,
    );
    const created = await proposeNextWorkflowInboxPlan({
      project: roadmap.project,
      job: roadmap.job,
      projects: roadmap.projects,
      head,
      watchRoot: 'docs',
      contract,
      handoverMetadata: { plan: 'docs/001_PLAN_20260731_owner.md' },
      signal,
    });
    assert.equal(created.status, 'created');
    if (created.status !== 'created') throw new Error('expected roadmap proposal');
    const content = roadmap.git('show', `HEAD:${created.planPath}`);
    assert.match(content, /First unclaimed item/);
    assert.doesNotMatch(content, /Later item/);
    assert.match(content, /roadmap: "docs\/roadmap\.md"/);
  } finally {
    await rm(roadmap.root, { recursive: true, force: true });
  }

  const integration = await fixture();
  try {
    const inbox = await addWorkflowInboxIssue({
      config: integration.projects,
      project: integration.project,
      job: integration.job,
      expectedHead: integration.base,
      title: 'Inbox candidate',
      requestId: 'integration-message',
    });
    assert.equal(inbox.state, 'created');
    await writeFile(path.join(integration.root, 'docs/003_HANDOVER_20260731_done.md'), `---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/001_PLAN_20260731_owner.md
slice: S01
plan_progress: complete
---
## 验证结果
- fixture passed
`);
    integration.git('add', '.');
    integration.git('commit', '-qm', 'complete owner plan');

    const run = (
      autonomy: 'manual' | 'semi_auto' | 'auto',
      cursor: unknown = { commit: integration.base },
    ) => workflowWatcherHandler({
      project: integration.project,
      job: integration.job,
      mode: 'active',
      workflowAutonomy: autonomy,
      cursor,
      signal,
    }, async () => assert.fail(`${autonomy} terminal phase completion must not start a Slice`), async () => 'doc-url',
    async () => 'review-message', async () => undefined, async () => integration.projects);

    assert.match((await run('manual')).summary, /result=notified/);
    assert.match((await run('semi_auto')).summary, /result=notified/);
    const proposed = await run('auto');
    assert.match(proposed.summary, /result=proposed/);
    assert.equal((proposed.cursor as { commit: string }).commit, integration.base);
    const proposalFiles = integration.git('-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'docs')
      .split('\n')
      .filter((file) => /_PLAN_.*WorkflowInbox/.test(file));
    assert.equal(proposalFiles.length, 1);
    const queued = await run('auto', proposed.cursor);
    assert.match(queued.summary, /action=await_approval result=notified/);
    const review = await run('auto', {
      ...(queued.cursor as Record<string, unknown>),
      selectedPlan: proposalFiles[0],
    });
    assert.match(review.summary, /gate=plan_review.*card_sent=true/);
    assert.equal(
      integration.git('-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'docs')
        .split('\n')
        .filter((file) => /_PLAN_.*WorkflowInbox/.test(file)).length,
      1,
      'watcher retry must not create a duplicate PLAN',
    );
  } finally {
    await rm(integration.root, { recursive: true, force: true });
  }

  const resume = await fixture();
  try {
    await writeFile(path.join(resume.root, 'docs/003_PLAN_20260731_parent.md'), `---
doc_type: PLAN
doc_status: in_progress
next_action: none
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---
## S01
## S02
`);
    await writeFile(path.join(resume.root, 'docs/004_PLAN_20260731_interrupt.md'), `---
doc_type: PLAN
doc_status: in_progress
next_action: none
plan_kind: interrupt
roadmap: null
parent_plan: docs/003_PLAN_20260731_parent.md
parent_slice: S01
return_to: S02
---
## S01
`);
    resume.git('add', '.');
    resume.git('commit', '-qm', 'add interrupt');
    const beforeHandover = resume.git('rev-parse', 'HEAD');
    await writeFile(path.join(resume.root, 'docs/005_HANDOVER_20260731_interrupt.md'), `---
doc_type: HANDOVER
doc_status: completed
next_action: resume_parent
plan: docs/004_PLAN_20260731_interrupt.md
slice: S01
plan_progress: complete
---
<!-- WORKFLOW_PROMPT_START -->
Read docs/005_HANDOVER_20260731_interrupt.md, docs/004_PLAN_20260731_interrupt.md and
docs/003_PLAN_20260731_parent.md, then resume S02.
<!-- WORKFLOW_PROMPT_END -->
`);
    resume.git('add', '.');
    resume.git('commit', '-qm', 'complete interrupt');
    let starts = 0;
    const run = (autonomy: 'semi_auto' | 'auto') => workflowWatcherHandler({
      project: resume.project,
      job: resume.job,
      mode: 'active',
      workflowAutonomy: autonomy,
      cursor: { commit: beforeHandover, eventKey: 'prior' },
      signal,
    }, async () => {
      starts += 1;
      return true;
    });
    assert.match((await run('semi_auto')).summary, /gate=autonomy_manual advance=resume_parent/);
    assert.equal(starts, 0);
    assert.match((await run('auto')).summary, /result=session_started/);
    assert.equal(starts, 1);
  } finally {
    await rm(resume.root, { recursive: true, force: true });
  }

  console.log('workflow roadmap inbox checks passed');
};

void main();
