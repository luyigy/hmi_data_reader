import { effectiveArchitectureReview, type GraphDefinition, type GraphNode } from './domain';
import type { RoleOption } from './role-configuration';
import { graphFormButtonName, type GraphFormDecision } from './card-actions';

export const graphModeLabels = { full: '完整 · 实施/架构/测试', lean: '精简 · 实施/测试', implement: '仅实施 · 未验收' };
const shortModeLabels = { full: '完整', lean: '精简', implement: '仅实施' };
type SelectOption = { value: string; label: string };

export function graphRolesReady(graph: GraphDefinition) {
  return graph.nodes.every((node) => node.executionMode === 'lean' || node.executionMode === 'implement'
    || !!effectiveArchitectureReview(graph, node));
}

const text = (content: string) => ({ tag: 'markdown', content });
const inline = (value: string) => value.replace(/`/g, "'").replace(/\s+/g, ' ').trim();
const shortRepository = (repository: string) => repository.replace(/\\/g, '/').split('/').filter(Boolean).pop() || repository;
const shortSelector = (selector: string) => selector.startsWith('platform_local:') ? selector.split(':').pop() || selector : selector;

function shortGoal(goal: string) {
  const characters = Array.from(inline(goal));
  return characters.length > 24 ? `${characters.slice(0, 24).join('')}…` : characters.join('');
}

function specName(definition: GraphDefinition) {
  if (definition.specPackage) {
    const parts = definition.specPackage.manifestPath.split('/');
    return parts[parts.length - 2] || definition.specRef;
  }
  const name = definition.specRef.replace(/\\/g, '/').split('/').pop() || definition.specRef;
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

function nodeRepositories(node: GraphNode) {
  return Array.from(new Set(node.executions.map((job) => shortRepository(job.repository))));
}

function nodeLabel(node: GraphNode, primaryRepository: string) {
  const otherRepositories = nodeRepositories(node).filter((repository) => repository !== primaryRepository);
  return `${node.key} ${shortGoal(node.goal)}${otherRepositories.length ? ` (${otherRepositories.join(', ')})` : ''}`;
}

function implementationSummary(node: GraphNode) {
  const multipleRepositories = new Set(node.executions.map((job) => job.repository)).size > 1;
  const multipleJobs = node.executions.length > 1;
  return node.executions.map((job) => {
    const jobLabel = multipleJobs ? `${job.key}${multipleRepositories ? `@${shortRepository(job.repository)}` : ''}:` : '';
    return `${jobLabel}${shortSelector(job.agentSelector)}`;
  }).join('、');
}

function acceptanceSummary(node: GraphNode) {
  if (node.executionMode === 'implement') return '未验收';
  if (node.acceptance.mode === 'automatic') return '自动';
  if (node.acceptance.mode === 'human') return '人工';
  return node.acceptance.reviewerId ? shortSelector(node.acceptance.reviewerId) : '未配置';
}

function roleSummary(definition: GraphDefinition, node: GraphNode) {
  const mode = node.executionMode || 'full';
  const roles = [`实施:${implementationSummary(node)}`];
  if (mode === 'full') roles.push(`审查:${shortSelector(effectiveArchitectureReview(definition, node)?.reviewerId || '未配置')}`);
  roles.push(`验收:${acceptanceSummary(node)}`);
  return `${shortModeLabels[mode]} · ${roles.join(' / ')}`;
}

function nodeRanks(definition: GraphDefinition) {
  const nodes = new Map(definition.nodes.map((node) => [node.key, node]));
  const ranks = new Map<string, number>();
  const visiting = new Set<string>();
  const rank = (key: string): number => {
    const existing = ranks.get(key);
    if (existing !== undefined) return existing;
    const node = nodes.get(key);
    if (!node || visiting.has(key)) throw new Error('Cannot format an invalid task graph');
    visiting.add(key);
    const value = node.dependsOn.length ? Math.max(...node.dependsOn.map(rank)) + 1 : 0;
    visiting.delete(key);
    ranks.set(key, value);
    return value;
  };
  definition.nodes.forEach((node) => rank(node.key));
  return ranks;
}

function dependencyLabel(node: GraphNode, previousLevel: GraphNode[], currentLevel: GraphNode[]) {
  if (!node.dependsOn.length) return '';
  const simpleSerial = currentLevel.length === 1 && node.dependsOn.length === 1
    && previousLevel.length === 1 && previousLevel[0].key === node.dependsOn[0];
  return simpleSerial ? '' : ` (← ${node.dependsOn.join(', ')})`;
}

export function formatGraphProposal(definition: GraphDefinition) {
  const ranks = nodeRanks(definition);
  const levels = Array.from({ length: Math.max(...Array.from(ranks.values())) + 1 }, (_, level) =>
    definition.nodes.filter((node) => ranks.get(node.key) === level));
  const primaryRepository = shortRepository(definition.specPackage?.repository || definition.nodes[0].executions[0].repository);
  const lines: string[] = [];
  levels.forEach((nodes, level) => {
    if (level > 0) lines.push('  ↓');
    if (nodes.length === 1) {
      const node = nodes[0];
      lines.push(`[${nodeLabel(node, primaryRepository)}]${dependencyLabel(node, levels[level - 1] || [], nodes)}`);
      lines.push(`  └ ${roleSummary(definition, node)}`);
      return;
    }
    lines.push('┌ 并行阶段');
    nodes.forEach((node, index) => {
      const last = index === nodes.length - 1;
      lines.push(`${last ? '└─' : '├─'} [${nodeLabel(node, primaryRepository)}]${dependencyLabel(node, levels[level - 1] || [], nodes)}`);
      lines.push(`${last ? '     ' : '│    '}└ ${roleSummary(definition, node)}`);
    });
  });
  const attachment = definition.specPackage ? '（完整目标、路径与验收细节见上方话题附件）' : '';
  const extra = definition.nodes.flatMap(node => (node.extraRepositories || []).map(repo => `${node.key}：${repo.access === 'write' ? '读写' : '只读'} ${repo.repository}`));
  const scope = extra.length ? `\n附加仓库授权：\n${extra.join('\n')}\n` : '';
  const forks = new Map<string, GraphNode[]>();
  for (const node of definition.nodes) {
    const key = [...node.dependsOn].sort().join('、');
    forks.set(key, [...(forks.get(key) || []), node]);
  }
  const summary = [`启动：${levels[0].map(node => node.key).join('、')}${levels[0].length > 1 ? ' 可并行' : ''}`];
  for (const [dependencies, children] of Array.from(forks.entries())) {
    if (dependencies && children.length > 1) summary.push(`${dependencies} 通过后：${children.map(node => node.key).join('、')} 可并行`);
  }
  summary.push('每票只等待自身前置；下图按依赖层级排列，不要求上一层全部结束。实际并发受运行上限与共享可写目录约束。');
  return `Spec：${specName(definition)}${attachment}\n\n${summary.join('\n')}\n\n\`\`\`text\n${lines.join('\n')}\n\`\`\`\n${scope}`;
}

export function buildGraphProposalCard(id: string, definition: GraphDefinition, version: number, hash: string,
  agents: RoleOption[] = [], requestedPage = -1) {
  if (definition.adoptRun) return {
    schema: '2.0', config: { update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '现有路线关联 Issues' } },
    body: { elements: [text(formatGraphProposal(definition)),
      text('只关联任务来源。已完成结果不重跑；待补材料、原话题、分工、模式与提交保持。确认不会启动或放行任务。'),
      ...(['approve', 'reject'] as const).map((decision) => ({ tag: 'button', type: decision === 'approve' ? 'primary_filled' : 'default',
        text: { tag: 'plain_text', content: decision === 'approve' ? '确认关联，保留进度' : '退回' },
        behaviors: [{ type: 'callback', value: { cmd: 'task-graph-launch', proposalId: id, decision, hash } }] })),
    ] },
  };
  const ready = graphRolesReady(definition);
  const editing = agents.length > 0 && Number.isInteger(requestedPage) && requestedPage >= 0;
  const pageSize = agents.length > 8 ? 1 : 2;
  const pageCount = Math.ceil(definition.nodes.length / pageSize);
  const page = editing ? Math.min(Math.max(requestedPage, 0), pageCount - 1) : 0;
  const callbackButton = (label: string, decision: 'approve' | 'reject' | 'expand', targetPage?: number) => ({
    tag: 'button', text: { tag: 'plain_text', content: label }, type: decision === 'approve' ? 'primary_filled' : 'default',
    behaviors: [{ type: 'callback', value: { cmd: 'task-graph-launch', proposalId: id, decision, hash,
      ...(targetPage !== undefined ? { page: targetPage } : {}) } }],
  });
  const formButton = (label: string, decision: GraphFormDecision, targetPage: number, confirmation?: string) => ({
    tag: 'button', text: { tag: 'plain_text', content: label }, type: decision === 'approve' ? 'primary_filled' : 'default',
    ...(confirmation ? { confirm: { title: { tag: 'plain_text', content: label },
      text: { tag: 'plain_text', content: confirmation } } } : {}),
    name: graphFormButtonName(id, hash, decision, targetPage), form_action_type: 'submit',
  });
  const agentChoices = agents.map((agent) => ({ value: agent.value, label: `${agent.label} · ${agent.participant.harnessType}` }));
  const select = (name: string, fieldLabel: string, value: string, options: SelectOption[]) => {
    const choices = [...options];
    if (value && !choices.some((option) => option.value === value)) choices.push({ value, label: value });
    return { tag: 'select_static', name, width: 'fill', required: true,
      placeholder: { tag: 'plain_text', content: '请选择' },
      options: choices.map((option) => ({ text: { tag: 'plain_text', content: `${fieldLabel}${option.label}` }, value: option.value })),
      ...(value ? { initial_option: value } : {}) };
  };
  const primaryRepository = shortRepository(definition.specPackage?.repository || definition.nodes[0].executions[0].repository);
  const operationText = ready ? '确认后按依赖自动推进，异常时暂停。'
    : '确认后按依赖自动推进，异常时暂停。\n⚠️ 仍有完整模式 Slice 未指定架构审查者，请展开调整。';
  const form = editing ? { tag: 'form', name: 'graph_roles', elements: [
    text(`**角色配置 · 第 ${page + 1}/${pageCount} 页**。翻页会保存本页；其他 Slice 的已保存配置保持。`),
    ...definition.nodes.map((node, i) => ({ node, i })).slice(page * pageSize, (page + 1) * pageSize).flatMap(({ node, i }) => {
      const mode = node.executionMode || 'full';
      const multipleJobs = node.executions.length > 1;
      return [
        text(`**${node.key} · ${shortGoal(node.goal)}${nodeRepositories(node).filter((repository) => repository !== primaryRepository).length
          ? ` (${nodeRepositories(node).filter((repository) => repository !== primaryRepository).join(', ')})` : ''}**`),
        select(`mode_${i}`, '模式：', mode, Object.entries(graphModeLabels).map(([value, label]) => ({ value, label }))),
        ...node.executions.map((job, j) => select(`job_${i}_${j}`, multipleJobs ? `实施(${job.key})：` : '实施：', job.agentSelector, agentChoices)),
        mode === 'lean' || mode === 'implement' ? text('审查：此模式不启用')
          : select(`architecture_${i}`, '审查：', effectiveArchitectureReview(definition, node)?.reviewerId || '', agentChoices),
        mode === 'implement' ? text('验收：仅交付，未验收')
          : select(`acceptance_${i}`, '验收：', node.acceptance.mode === 'automatic' ? 'automatic'
            : node.acceptance.mode === 'human' ? 'human' : node.acceptance.reviewerId || '',
          [{ value: 'automatic', label: '自动检查' }, { value: 'human', label: '人工验收' }, ...agentChoices]),
      ];
    }),
    ...(page > 0 ? [formButton('◀ 保存并上一页', 'page', page - 1)] : []),
    ...(page + 1 < pageCount ? [formButton('保存并下一页 ▶', 'page', page + 1)] : []),
    formButton('保存并收起', 'configure', -1),
    formButton('重置推荐分配', 'suggest', page, '这会覆盖整条路线已手动调整的实施、架构和验收角色。'),
    text(operationText),
    ...(ready ? [formButton('确认并启动', 'approve', -1)] : []),
  ] } : null;
  return { schema: '2.0', config: { update_multi: true },
    header: { template: ready ? 'blue' : 'orange', title: { tag: 'plain_text', content: `任务路线待确认 · V${version}` } },
    body: { elements: [
      text(formatGraphProposal(definition)),
      ...(form ? [form] : []),
      ...(!form ? [text(operationText)] : []),
      ...(!form && ready ? [callbackButton('确认并启动', 'approve')] : []),
      ...(!form && agents.length ? [callbackButton('展开调整配置', 'expand', 0)] : []),
      callbackButton('退回修改', 'reject'),
    ] } };
}

export function graphCardMetrics(card: unknown): { elements: number; bytes: number } {
  const count = (value: unknown): number => {
    if (Array.isArray(value)) return value.reduce((total, child) => total + count(child), 0);
    if (!value || typeof value !== 'object') return 0;
    return Object.entries(value).reduce((total, [key, child]) => total + (key === 'tag' && typeof child === 'string' ? 1 : count(child)), 0);
  };
  return { elements: count(card), bytes: Buffer.byteLength(JSON.stringify(card)) };
}

export function assertGraphCardBudget(card: unknown) {
  const metrics = graphCardMetrics(card);
  if (metrics.elements > 200 || metrics.bytes > 28_000) {
    throw new Error(`路线卡超出发送预算（${metrics.elements} 元素，${metrics.bytes} bytes）；附件尚未发送，请缩短交付说明或候选名单。`);
  }
}
