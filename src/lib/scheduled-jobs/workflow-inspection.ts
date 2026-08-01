import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { readWorkflowContract, selectWorkflowCandidates, workflowFrontMatter } from './workflow-validator';
import type { WorkflowStatus } from './workflow-status';

const execFileAsync = promisify(execFile);

const git = async (repository: string, ...args: string[]) => (
  await execFileAsync('git', ['-C', repository, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8' })
).stdout.trim();

const record = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

export async function inspectWorkflowCursor(repository: string, ref: string, cursor: unknown) {
  const latest = await git(repository, 'rev-parse', ref);
  const current = typeof record(cursor)?.commit === 'string' ? String(record(cursor)?.commit) : undefined;
  if (!current) return { current, latest, rewritten: false, behind: undefined };
  try {
    await git(repository, 'merge-base', '--is-ancestor', current, latest);
    return {
      current,
      latest,
      rewritten: false,
      behind: Number(await git(repository, 'rev-list', '--count', `${current}..${latest}`)),
    };
  } catch {
    return { current, latest, rewritten: true, behind: undefined };
  }
}

export async function inspectWorkflowCandidates(
  repository: string,
  head: string,
  cursor: unknown,
  config: Record<string, unknown>,
) {
  const contractPath = String(config.contract_path || '');
  const branchSpace = String(config.branch_space || '');
  const initialCursor = String(config.initial_cursor_commit || '');
  if (!contractPath || path.isAbsolute(contractPath) || contractPath.split('/').includes('..')) {
    throw new Error('contract_path must stay inside the repository');
  }
  if (!branchSpace || branchSpace.includes('/') || branchSpace === '..') {
    throw new Error('workflow_watcher requires a single-directory config.branch_space');
  }
  const cursorValue = record(cursor);
  const current = typeof cursorValue?.commit === 'string' ? cursorValue.commit : initialCursor;
  if (!current) throw new Error('workflow_watcher requires config.initial_cursor_commit for first run');
  const contract = await readWorkflowContract(repository, head, contractPath, new AbortController().signal);
  const watchRoot = path.posix.join(contract.branch_spaces.root, branchSpace);
  const scanFrom = 'eventKey' in (cursorValue ?? {}) ? current : initialCursor;
  const changed = scanFrom === head ? [] : (await git(
    repository, 'diff', '--name-only', '--diff-filter=AMR', scanFrom, head, '--', watchRoot,
  )).split('\n').filter(Boolean);
  return selectWorkflowCandidates(changed, contract, watchRoot).map(({ filePath }) => filePath);
}

const targetSlice = (content: string) => {
  const prompt = content.match(/<!-- WORKFLOW_PROMPT_START -->([\s\S]*?)<!-- WORKFLOW_PROMPT_END -->/)?.[1] ?? '';
  return prompt.match(/\b(?:执行|继续)[^\n]*?\b(S\d{2,})\b/)?.[1];
};

const planReference = (metadata: Record<string, unknown>, filePath: string) => {
  const value = typeof metadata.plan === 'string' ? metadata.plan : '';
  return value && !value.includes('/') ? path.posix.join(path.posix.dirname(filePath), value) : value;
};

export type WorkflowPlanInspection = {
  path: string;
  number: number;
  title: string;
  state: string;
  queuePosition?: number;
  duplicateOf?: string;
  slices: Array<{ id: string; title: string; state: string }>;
};

export type WorkflowOverview = {
  queue: WorkflowPlanInspection[];
  plans: WorkflowPlanInspection[];
  warnings: string[];
};

export async function inspectWorkflowOverview(
  repository: string,
  head: string,
  cursor: unknown,
  config: Record<string, unknown>,
  status: WorkflowStatus,
) {
  const cursorValue = record(cursor);
  const pending = record(cursorValue?.pending);
  const queuedDocuments = await inspectWorkflowCandidates(repository, head, cursor, config);
  const currentPath = String(pending?.path || status.documentPath || '-');
  let currentContent = '';
  if (currentPath !== '-') {
    currentContent = await git(repository, 'show', `${head}:${currentPath}`).catch(() => '');
  }
  const currentMetadata = currentContent ? workflowFrontMatter(currentContent) : {};
  const currentPlan = String(
    currentMetadata.plan
      || (/_PLAN_/.test(currentPath) ? currentPath : '')
      || (status.plan !== '-' ? status.plan : ''),
  );
  const activeSlice = targetSlice(currentContent) || (status.slice !== '-' ? status.slice : '');
  const contractPath = String(config.contract_path || '');
  const branchSpace = String(config.branch_space || '');
  const contract = await readWorkflowContract(repository, head, contractPath, new AbortController().signal);
  const watchRoot = path.posix.join(contract.branch_spaces.root, branchSpace);
  const files = (await git(repository, 'ls-tree', '-r', '--name-only', head, '--', watchRoot)).split('\n').filter(Boolean);
  // ponytail: one git show per workflow doc; use cat-file --batch only if status latency becomes measurable.
  const parsedDocuments = await Promise.all(selectWorkflowCandidates(files, contract, watchRoot).map(async (candidate) => {
    const content = await git(repository, 'show', `${head}:${candidate.filePath}`);
    try {
      return { ...candidate, content, metadata: workflowFrontMatter(content), error: '' };
    } catch (error) {
      return {
        ...candidate,
        content,
        metadata: {} as Record<string, unknown>,
        error: `${candidate.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }));
  const documents = parsedDocuments.filter(({ error }) => !error);
  const handovers = documents.filter(({ type }) => type === 'HANDOVER');
  const queuedPlans = new Set((await Promise.all(queuedDocuments.map(async (filePath) => {
    if (/_PLAN_/.test(filePath)) return filePath;
    const content = await git(repository, 'show', `${head}:${filePath}`).catch(() => '');
    return content ? planReference(workflowFrontMatter(content), filePath) : '';
  }))).filter(Boolean));
  const planRows = documents.filter(({ type }) => type === 'PLAN').map((plan) => {
    const planHandovers = handovers
      .filter(({ metadata, filePath }) => planReference(metadata, filePath) === plan.filePath)
      .sort((left, right) => left.number - right.number);
    const latest = planHandovers.at(-1)?.metadata;
    const completed = new Set(planHandovers.flatMap(({ metadata }) => (
      metadata.doc_status === 'completed' && typeof metadata.slice === 'string' ? [metadata.slice] : []
    )));
    const title = plan.content.match(/^#\s+PLAN\s*[·・-]\s*(.+)$/m)?.[1]?.trim()
      ?? path.posix.basename(plan.filePath);
    const complete = plan.metadata.doc_status === 'completed' || latest?.plan_progress === 'complete';
    const blocked = plan.metadata.doc_status === 'blocked' || latest?.next_action === 'blocked';
    const planActiveSlice = plan.filePath === currentPlan
      ? activeSlice
      : typeof latest?.slice === 'string' ? latest.slice : '';
    const state = complete ? '实施完成，等待人工验收'
      : blocked ? '阻塞'
        : plan.filePath === currentPlan ? status.running ? '执行中' : status.stage
          : plan.metadata.doc_status === 'draft' || plan.metadata.next_action === 'await_plan_approval' ? '等待审批'
            : queuedPlans.has(plan.filePath) ? '等待 watcher 领取'
              : '等待启动（未进入 watcher 队列）';
    const slices = Array.from(plan.content.matchAll(/^#{2,6}\s+(S\d{2,})[：:\s-]+(.+)$/gm), (match) => ({
      id: match[1],
      title: match[2].trim(),
      state: completed.has(match[1]) ? '已完成'
        : match[1] === planActiveSlice ? blocked ? '阻塞' : status.running && plan.filePath === currentPlan ? '执行中' : '当前 Slice'
          : '未开始',
    }));
    return { path: plan.filePath, number: plan.number, title, state, slices, complete };
  });
  const latestComplete = planRows.filter(({ complete }) => complete).sort((a, b) => b.number - a.number)[0];
  const plans: WorkflowPlanInspection[] = planRows
    .filter((plan) => !plan.complete || plan === latestComplete || plan.path === currentPlan)
    .sort((a, b) => a.number - b.number)
    .map((plan) => ({
      path: plan.path,
      number: plan.number,
      title: plan.title,
      state: plan.state,
      slices: plan.slices,
    }));
  const firstByTitle = new Map<string, WorkflowPlanInspection>();
  for (const plan of plans) {
    const original = firstByTitle.get(plan.title);
    if (original) {
      plan.duplicateOf = original.path;
      plan.state = `重复计划（同 ${original.number}）`;
    } else firstByTitle.set(plan.title, plan);
  }
  const queue = plans.filter(({ state, duplicateOf }) => (
    !duplicateOf && !['阻塞', '实施完成，等待人工验收'].includes(state)
  ));
  queue.forEach((plan, index) => { plan.queuePosition = index + 1; });
  const warnings = [
    ...plans.filter(({ state }) => state.includes('未进入 watcher 队列'))
      .map(({ number }) => `${number} 已就绪但未进入 watcher 队列`),
    ...plans.filter(({ duplicateOf }) => duplicateOf)
      .map(({ number, duplicateOf }) => `${number} 与 ${path.posix.basename(duplicateOf!)} 重复`),
  ];
  return { queue, plans, warnings };
}

export const formatWorkflowOverview = (overview: Awaited<ReturnType<typeof inspectWorkflowOverview>>) => [
  `当前计划：${overview.plans.length} 个；排队：${overview.queue.length} 个`,
  '排队序列：',
  ...(overview.queue.length
    ? overview.queue.map(({ queuePosition, number, title, state }) => `${queuePosition}. ${number} ${title} · ${state}`)
    : ['无']),
  '全部计划与 Slice：',
  ...overview.plans.flatMap((plan) => [
    `- ${plan.number} ${plan.title} · ${plan.state}`,
    ...(plan.slices.length
      ? plan.slices.map(({ id, title, state }) => `  - ${id} ${state} · ${title}`)
      : ['  - 无可识别的 Slice']),
  ]),
  ...(overview.warnings.length ? ['异常：', ...overview.warnings.map((warning) => `- ${warning}`)] : []),
].join('\n');

export const buildWorkflowSkipCursor = (cursor: unknown, documentPath: string) => {
  const current = record(cursor);
  const pending = record(current?.pending);
  if (!current || pending?.path !== documentPath) return null;
  const next = { ...current };
  delete next.pending;
  return next;
};

export const buildWorkflowActivateCursor = (cursor: unknown, planPath: string) => {
  const current = record(cursor);
  if (!current || record(current.pending)) return null;
  return { ...current, selectedPlan: planPath };
};
