import { effectiveArchitectureReview, type GraphDefinition } from './domain';
import type { RoleOption } from './role-configuration';
import { graphFormButtonName, type GraphFormDecision } from './card-actions';

export const graphModeLabels = { full: '完整 · 实施/架构/测试', lean: '精简 · 实施/测试', implement: '仅实施 · 未验收' };
export function graphRolesReady(graph: GraphDefinition) {
  return graph.nodes.every((node) => node.executionMode === 'lean' || node.executionMode === 'implement'
    || !!effectiveArchitectureReview(graph, node));
}

export function formatGraphProposal(definition: GraphDefinition, version: number, includeEdges = true) {
  const lines = [`任务路线 V${version}`, `Spec：${definition.specRef}`,
    ...(definition.specPackage ? [`Spec 包 SHA-256：${definition.specPackage.hash}`] : []), ...(includeEdges ? ['**依赖关系图**'] : [])];
  for (const node of includeEdges ? definition.nodes : []) {
    const next = definition.nodes.filter((item) => item.dependsOn.includes(node.key)).map((item) => item.key);
    if (next.length) lines.push(`${node.key} → ${next.join(' ∥ ')}${next.length > 1 ? '（前置通过后可并行）' : ''}`);
  }
  lines.push('所有前置达到该片批准的完成条件后自动启动；各仓实施、集成和验收进度回到父任务。');
  for (const node of definition.nodes) {
    lines.push(`**${node.key} · ${node.goal}**`, `前置：${node.dependsOn.join('、') || '无'} · ${graphModeLabels[node.executionMode || 'full']}`,
      `实施者：${node.executions.map((job) => `${job.repository} / ${job.agentSelector}`).join('；')}`,
      `验收者：${node.executionMode === 'implement' ? '不启用，结果未验收' : node.acceptance.mode === 'automatic' ? '自动检查' : node.acceptance.reviewerId || '未配置'}；验收项：${node.acceptance.checks.join('、')}`,
      `架构复核者：${effectiveArchitectureReview(definition, node)?.reviewerId || (node.executionMode === 'lean' || node.executionMode === 'implement' ? '此模式不启用' : '未配置')}`);
  }
  return lines.join('\n');
}

export function buildGraphProposalCard(id: string, definition: GraphDefinition, version: number, hash: string, agents: RoleOption[] = [], requestedPage = 0, imageKey?: string | null) {
  const ready = graphRolesReady(definition);
  const pageSize = agents.length > 8 ? 1 : 2;
  const pageCount = Math.ceil(definition.nodes.length / pageSize);
  const page = Math.min(Math.max(Number.isInteger(requestedPage) ? requestedPage : 0, 0), pageCount - 1);
  const callback = (decision: string) => ({ cmd: 'task-graph-launch', proposalId: id, decision, hash });
  const button = (text: string, decision: GraphFormDecision | 'reject', submit = false, targetPage = page) => ({ tag: 'button',
    text: { tag: 'plain_text', content: text }, type: decision === 'approve' ? 'primary_filled' : 'default',
    ...(submit && decision !== 'reject' ? { name: graphFormButtonName(id, hash, decision, targetPage), form_action_type: 'submit' }
      : { behaviors: [{ type: 'callback', value: callback(decision) }] }) });
  const choices = agents.map((agent) => ({ value: agent.value, label: `${agent.label} · ${agent.participant.harnessType}` }));
  const select = (name: string, value: string, extra: { value: string; label: string }[] = []) => {
    const options = [...extra, ...choices];
    if (value && !options.some((option) => option.value === value)) options.push({ value, label: value });
    return { tag: 'select_static', name, width: 'fill', required: true,
      placeholder: { tag: 'plain_text', content: '请选择' },
      options: options.map((option) => ({ text: { tag: 'plain_text', content: option.label }, value: option.value })),
      ...(value ? { initial_option: value } : {}) };
  };
  const columns = (cells: Record<string, unknown>[][]) => ({ tag: 'column_set',
    flex_mode: 'none', columns: cells.map((elements) => ({ tag: 'column', width: 'weighted', weight: 1, elements })) });
  const text = (content: string) => ({ tag: 'markdown', content });
  return { schema: '2.0', config: { update_multi: true },
    header: { template: ready ? 'blue' : 'orange', title: { tag: 'plain_text', content: `任务路线待确认 · V${version}` } },
    body: { elements: [
      ...(imageKey ? [{ tag: 'img', img_key: imageKey, alt: { tag: 'plain_text', content: 'Slice 依赖与并行路线图' }, scale_type: 'fit_horizontal', preview: true }] : []),
      text(formatGraphProposal(definition, version, !imageKey)),
      text('**一次确认后自动接力。** 每项写入使用独立 worktree，自动集成到本次运行分支。仅实施会放行未验收结果；异常或选定的人工验收会暂停。'),
      ...(agents.length ? [{ tag: 'form', name: 'graph_roles', elements: [
        text(`**角色配置 · 第 ${page + 1}/${pageCount} 页**。翻页会保存本页选择；其他 Slice 的已保存配置保持。确认按钮批准整条路线。`),
        ...(definition.nodes.some((node) => !node.executionMode || node.executionMode === 'full') ? [
          text('完整模式的项目默认架构审查者（各片可覆盖）：'),
          select('architecture_default', definition.defaultArchitectureReview?.reviewerId || 'none', [{ value: 'none', label: '未设置' }]),
        ] : []),
        columns(['阶段 / 模式', '实施 harness', '架构审查', '测试验收'].map((label) => [text(`**${label}**`)])),
        ...definition.nodes.map((node, i) => ({ node, i })).slice(page * pageSize, (page + 1) * pageSize).map(({ node, i }) => columns([
          [text(`**${node.key}**`), { tag: 'select_static', name: `mode_${i}`, width: 'fill', required: true,
            initial_option: node.executionMode || 'full', options: Object.entries(graphModeLabels).map(([value, label]) => ({ value, text: { tag: 'plain_text', content: label } })) }],
          node.executions.flatMap((job, j) => [text(job.key), select(`job_${i}_${j}`, job.agentSelector)]),
          node.executionMode === 'lean' || node.executionMode === 'implement' ? [text('此模式不启用')]
            : [select(`architecture_${i}`, node.architectureReview?.reviewerId || 'inherit', [{ value: 'inherit', label: `继承项目默认${definition.defaultArchitectureReview ? ` · ${definition.defaultArchitectureReview.reviewerId}` : '（未设置）'}` }])],
          node.executionMode === 'implement' ? [text('仅交付，未验收')]
            : [select(`acceptance_${i}`, node.acceptance.mode === 'automatic' ? 'automatic' : node.acceptance.mode === 'human' ? 'human' : node.acceptance.reviewerId || '',
              [{ value: 'automatic', label: '自动检查' }, { value: 'human', label: '人工验收' }])],
        ])),
        ...(page > 0 ? [button('保存本页并上一页', 'page', true, page - 1)] : []),
        ...(page + 1 < pageCount ? [button('保存本页并下一页', 'page', true, page + 1)] : []),
        button('整条路线按房间角色填建议分配', 'suggest', true), button('保存本页模式与角色', 'configure', true),
        ...(ready ? [button('确认并启动路线', 'approve', true)] : []),
      ] }] : []),
      text(ready ? '当前配置可确认。' : '完整模式仍缺架构审查者；请先调整并保存。精简和仅实施不要求架构审查者。'),
      ...(ready && !agents.length ? [button('确认并启动路线', 'approve')] : []), button('退回修改', 'reject'),
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
