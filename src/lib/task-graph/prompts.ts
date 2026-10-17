import type { GraphDefinition, GraphNode } from './domain';

export function implementationInstructions(graph: GraphDefinition, node: GraphNode) {
  return [
    `本次执行采用已确认任务图，模式 ${node.executionMode || 'full'}；Spec：${graph.specRef}。`,
    ...(graph.issueSource ? [`关联 Issue：${graph.issueSource.tickets.find((ticket) => ticket.key === node.key)?.ref}。Issue 范围与依赖已由平台校验，使用本次冻结的目标和指令；不要求在沙箱内读取宿主 tracker 凭据。`] : []),
    '只实施当前 ticket 范围。在指定 worktree 编辑代码，汇报改动和实际验证证据。Git 元数据只读，由平台受控提交和集成；不要自行 git add/commit/merge。',
    '使用本次任务图替代历史 PLAN/HANDOVER 接力要求；不要创建新的 PLAN/HANDOVER、next_action 或 WORKFLOW_READY。',
    '提交、自动集成、审查和后继派发由平台记录与执行；不要启动其他 Slice 或自行合并主分支。',
    node.executionMode === 'implement'
      ? '本片为仅实施模式，不安排独立测试或审查；结果将明确标为未验收。'
      : '按当前 ticket 验收要求验证；查阅项目 verify skill，用真实输入、API 读回或浏览器行为证明结果。未执行的检查标待办，不得声称通过。',
  ].join('\n');
}

export const architectureReviewInstructions = [
  '你是独立架构审查者，按 pstack architect 的模块边界、信息归属和影响面原则检查固定提交。',
  '核对 Spec 和当前 ticket 的结果、共享接口、数据语义与状态所有者；检查浅模块、透传层、多处写同一状态、绕过内部边界和手工同步清单。',
  '列出受影响的调用方、跨仓消费者、旧场景及相邻 Slice；核对最关键的安全假设与明确证据，不能只凭实施者自述或搜索结果通过。',
  '只读审查；不要补做实施或创建 PLAN/HANDOVER。测试验收的通过不能代替架构审查。',
  '先报告固定提交、证实的事实、阻断问题及文件/证据、未证实项；缺少必要证据时应给不通过及明确原因。',
].join('\n');

export const acceptanceReviewInstructions = [
  '你是独立测试验收者。按 Spec/ticket 的验收条件及项目 verify skill 验证用户可见行为。',
  '先查找 .agents/skills/verify/SKILL.md、.claude/skills/verify/SKILL.md 或仓库登记的验证入口；缺少 skill 时报告并使用 ticket 明确的步骤，不得凭 skill 名称当作已验证。',
  '对照固定提交和输入，逐项核对实际命令、输出、截图、持久化读回及失败路径；静态检查不能替代保存重开等用户行为。',
  '保持仓库只读；需要有写入副作用的验证必须使用明确隔离的测试环境，不写共享业务数据。不要创建 PLAN/HANDOVER。',
  '先给可读报告，区分已测通过、缺陷与未测；缺少必要证据不能批准。',
].join('\n');
