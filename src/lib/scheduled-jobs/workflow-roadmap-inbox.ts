import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { JobConfig, ProjectConfig, ProjectsConfig } from './project-config';
import { workflowFrontMatter, type WorkflowContract } from './workflow-validator';

const execFileAsync = promisify(execFile);

const git = async (cwd: string, signal: AbortSignal, ...args: string[]) =>
  (await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    signal,
  })).stdout.trim();

const safeReference = (value: unknown, watchRoot: string) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const reference = value.replace(/^\.\//, '');
  const resolved = reference.includes('/') ? reference : path.posix.join(watchRoot, reference);
  if (resolved.split('/').includes('..') || !resolved.startsWith(`${watchRoot}/`)) return null;
  return resolved;
};

const workflowConsumers = (
  projects: ProjectsConfig,
  project: ProjectConfig,
  branchSpace: string,
) => projects.projects.flatMap((candidate) =>
  candidate.path === project.path && candidate.ref === project.ref
    ? candidate.jobs.filter((job) =>
        job.type === 'workflow_watcher'
        && String(job.config.branch_space || '') === branchSpace)
      .map((job) => `${candidate.id}/${job.id}`)
    : []);

const titleFrom = (content: string, fallback: string) =>
  content.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;

const itemKey = (sourcePath: string, item: string) =>
  createHash('sha256').update(`${sourcePath}\n${item}`).digest('hex').slice(0, 16);

const planMarker = (key: string) => `<!-- WORKFLOW_INBOX_ITEM: ${key} -->`;

const planExists = async (
  cwd: string,
  head: string,
  watchRoot: string,
  key: string,
  signal: AbortSignal,
) => {
  const files = (await git(cwd, signal, 'ls-tree', '-r', '--name-only', head, '--', watchRoot))
    .split('\n')
    .filter((file) => /\/\d+_PLAN_\d{8}_.+\.md$/.test(`/${file}`));
  for (const file of files) {
    if ((await git(cwd, signal, 'show', `${head}:${file}`)).includes(planMarker(key))) return file;
  }
  return null;
};

const selectSourceItem = async (args: {
  cwd: string;
  head: string;
  watchRoot: string;
  planMetadata: Record<string, unknown>;
  signal: AbortSignal;
}) => {
  const roadmapPath = safeReference(args.planMetadata.roadmap, args.watchRoot);
  if (args.planMetadata.roadmap && !roadmapPath) {
    throw new Error('phase PLAN roadmap must stay inside the workflow branch space');
  }
  if (roadmapPath) {
    const content = await git(args.cwd, args.signal, 'show', `${args.head}:${roadmapPath}`);
    const items = Array.from(content.matchAll(/^\s*[-*]\s+\[\s\]\s+(.+)$/gm), (match) => match[1].trim());
    return {
      sourcePath: roadmapPath,
      sourceKind: 'roadmap' as const,
      items: items.map((item) => ({ item, detail: item })),
    };
  }

  const inboxRoot = path.posix.join(args.watchRoot, 'inbox');
  const files = (await git(args.cwd, args.signal, 'ls-tree', '-r', '--name-only', args.head, '--', inboxRoot))
    .split('\n')
    .filter((file) => file.endsWith('.md') && path.posix.basename(file).toLowerCase() !== 'readme.md');
  return {
    sourcePath: inboxRoot,
    sourceKind: 'inbox' as const,
    items: await Promise.all(files.map(async (file) => {
      const content = await git(args.cwd, args.signal, 'show', `${args.head}:${file}`);
      return {
        item: titleFrom(content, path.posix.basename(file, '.md')),
        detail: content.trim(),
        file,
      };
    })),
  };
};

export type WorkflowInboxProposalResult =
  | { status: 'created'; planPath: string; eventKey: string; sourcePath: string }
  | { status: 'no_source' | 'empty' | 'exhausted' | 'conflict' | 'stale' | 'not_phase'; reason: string };

export async function proposeNextWorkflowInboxPlan(args: {
  project: ProjectConfig;
  job: JobConfig;
  projects: ProjectsConfig;
  head: string;
  watchRoot: string;
  contract: WorkflowContract;
  handoverMetadata: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<WorkflowInboxProposalResult> {
  const branchSpace = String(args.job.config.branch_space || '');
  const consumers = workflowConsumers(args.projects, args.project, branchSpace);
  if (consumers.length !== 1 || consumers[0] !== `${args.project.id}/${args.job.id}`) {
    return {
      status: 'conflict',
      reason: `Roadmap/Inbox consumer ownership is not unique: ${consumers.join(', ') || 'unregistered'}`,
    };
  }
  if (!args.project.ref.startsWith('refs/heads/')) {
    return { status: 'conflict', reason: 'Roadmap/Inbox proposals require a monitored branch ref' };
  }
  const currentRef = await git(args.project.path, args.signal, 'symbolic-ref', '-q', 'HEAD').catch(() => '');
  if (currentRef !== args.project.ref) {
    return { status: 'conflict', reason: `working tree is not on ${args.project.ref}` };
  }
  if ((await git(args.project.path, args.signal, 'rev-parse', args.project.ref)) !== args.head) {
    return { status: 'stale', reason: 'Git HEAD changed before Roadmap/Inbox selection' };
  }

  const planReference = safeReference(args.handoverMetadata.plan, args.watchRoot);
  if (!planReference) return { status: 'no_source', reason: 'completed HANDOVER has no valid PLAN reference' };
  const planContent = await git(args.project.path, args.signal, 'show', `${args.head}:${planReference}`);
  const planMetadata = workflowFrontMatter(planContent);
  if (planMetadata.plan_kind !== args.contract.documents.plan.phase_kind) {
    return { status: 'not_phase', reason: 'only completed phase PLANs may propose Roadmap/Inbox work' };
  }

  const source = await selectSourceItem({
    cwd: args.project.path,
    head: args.head,
    watchRoot: args.watchRoot,
    planMetadata,
    signal: args.signal,
  });
  if (!source.items.length) {
    return {
      status: planMetadata.roadmap ? 'empty' : 'no_source',
      reason: planMetadata.roadmap
        ? `Roadmap has no unfinished checklist item: ${source.sourcePath}`
        : `Git Inbox has no committed item: ${source.sourcePath}`,
    };
  }

  for (const candidate of source.items) {
    const sourcePath = 'file' in candidate ? candidate.file : source.sourcePath;
    const key = itemKey(sourcePath, candidate.item);
    const existing = await planExists(
      args.project.path,
      args.head,
      args.watchRoot,
      key,
      args.signal,
    );
    const eventKey = `workflow-inbox:${args.head}:${key}`;
    if (existing) continue;

    const names = (await git(
      args.project.path,
      args.signal,
      'ls-tree',
      '-r',
      '--name-only',
      args.head,
      '--',
      args.watchRoot,
    )).split('\n');
    let number = Math.max(
      0,
      ...names.map((name) => Number(path.posix.basename(name).match(/^(\d+)_/)?.[1] || 0)),
    ) + 1;
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    let planPath = '';
    while (!planPath) {
      const candidatePath = path.posix.join(
        args.watchRoot,
        `${String(number).padStart(args.contract.numbering.width, '0')}_PLAN_${date}_WorkflowInbox提案_${key.slice(0, 8)}.md`,
      );
      try {
        const roadmap = source.sourceKind === 'roadmap' ? source.sourcePath : null;
        await fs.writeFile(path.join(args.project.path, candidatePath), [
          '---',
          'doc_type: PLAN',
          'doc_status: ready',
          'next_action: await_approval',
          'plan_kind: phase',
          `roadmap: ${roadmap ? JSON.stringify(roadmap) : 'null'}`,
          'parent_plan: null',
          'parent_slice: null',
          'return_to: null',
          '---',
          '',
          `# PLAN · ${candidate.item}`,
          '',
          planMarker(key),
          `<!-- WORKFLOW_EXPECTED_HEAD: ${args.head} -->`,
          '',
          '## 来源',
          '',
          `- Git 来源：${sourcePath}`,
          `- 候选条目：${candidate.item}`,
          '',
          '## 目标',
          '',
          candidate.detail,
          '',
          '## S01：确认范围并实施',
          '',
          '- 先读取来源、当前 HEAD 与相关实现，确认边界后完成最小实现和验证。',
          '- 不扩展到来源条目之外；发现 HEAD 或需求失效时停止并说明。',
          '',
          '<!-- WORKFLOW_PROMPT_START -->',
          `执行 \`${candidatePath}\` 的 S01：先读取目标 HEAD 的 \`AGENTS.md\`、`,
          `\`docs/workflow/workflow-contract.yaml\`、本 PLAN 和来源 \`${sourcePath}\`。`,
          '保护所有开工前用户改动，只完成该候选条目的最小可验证实现；修改现有符号前执行 GitNexus upstream impact，',
          '完成 TypeScript、相关聚焦测试、定向 ESLint、长文件检查、diff check 与 GitNexus detect_changes 后精确提交，',
          '并按 workflow contract 创建 HANDOVER；提交后停止。当前 Slice：S01。',
          '<!-- WORKFLOW_PROMPT_END -->',
          '',
        ].join('\n'), { encoding: 'utf8', flag: 'wx' });
        planPath = candidatePath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        number += 1;
      }
    }

    if ((await git(args.project.path, args.signal, 'rev-parse', args.project.ref)) !== args.head) {
      await fs.unlink(path.join(args.project.path, planPath));
      return { status: 'stale', reason: 'Git HEAD changed before PLAN commit' };
    }
    await git(args.project.path, args.signal, 'add', '--', planPath);
    await git(
      args.project.path,
      args.signal,
      'commit',
      '--only',
      '-m',
      `docs(workflow): propose inbox item ${key.slice(0, 8)}`,
      '-m',
      `Workflow-Inbox-Event: ${eventKey}`,
      '--',
      planPath,
    );
    return { status: 'created', planPath, eventKey, sourcePath };
  }

  return { status: 'exhausted', reason: `all items are already claimed: ${source.sourcePath}` };
}
