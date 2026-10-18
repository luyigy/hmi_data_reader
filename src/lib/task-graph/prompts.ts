import type { GraphDefinition, GraphNode } from './domain';

export function implementationInstructions(graph: GraphDefinition, node: GraphNode) {
  return [
    `本次执行采用已确认任务图，模式 ${node.executionMode || 'full'}；Spec：${graph.specRef}。`,
    ...(graph.issueSource ? [`关联 Issue：${graph.issueSource.tickets.find((ticket) => ticket.key === node.key)?.ref}。Issue 范围与依赖已由平台校验，使用本次冻结的目标和指令；不要求在沙箱内读取宿主 tracker 凭据。`] : []),
    '只实施当前 ticket 范围。在指定 worktree 编辑代码，汇报改动和实际验证证据。Git 元数据只读，由平台受控提交和集成；不要自行 git add/commit/merge。',
    '平台默认只读复用源项目已配置的 Python 环境，PATH 自动提供同一解释器和命令。不要另建虚拟环境、pip install --user 或修改共享依赖；缺依赖/版本冲突请明确报告，单独处理项目环境变更。',
    '使用本次任务图替代历史 PLAN/HANDOVER 接力要求；不要创建新的 PLAN/HANDOVER、next_action 或 WORKFLOW_READY。',
    '提交、自动集成、审查和后继派发由平台记录与执行；不要启动其他 Slice 或自行合并主分支。',
    '最终单独一行给出唯一结构化结论：TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"实际交付说明","evidence":["实际文件、命令或读回证据"]}。只有确实完成本仓目标才能 delivered。',
    '先使用仓内已有输入、任务已挂载材料和已配置工具完成当前 ticket。可选外部工具未配置、可选辅助模型失败或缺少可选 skill，不得作为 blocked 理由；使用已批准的可用路径继续实施和验证。功能尚未实现、测试暴露缺陷属于本票待解决工作，不能仅改写成缺材料报告后退出。保留暂停期间新增的源码、Spec 和材料更正，不 reset、stash 或删除这些改动。',
    '只有完成本票所必需的输入、环境、材料或权限确实缺失，且已核查现有材料、尝试获批替代路径仍无法推进时，才用 TASK_GRAPH_IMPLEMENTATION {"status":"blocked","blockerKind":"missing_business_material 或 missing_upstream_input 或 environment_failed 或 scope_change 或 permission_required","note":"具体缺失项与保存进度"}。阻塞不会集成或放行后继；平台保存进度，补齐后恢复实施。普通会话结束不代表交付，不得把阻塞报告当作实施完成。',
    node.executionMode === 'implement'
      ? '本片为仅实施模式，不安排独立测试或审查；结果将明确标为未验收。'
      : '按当前 ticket 验收要求验证；项目存在 verify skill 时查阅它，没有时按 ticket 明确的入口执行并说明，不把缺少可选 skill 当成执行失败。用真实输入、API 读回或浏览器行为证明结果。未执行的检查标待办，不得声称通过。',
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
  '项目 Python 环境由平台自动选择并只读挂载，实施、检查和验收使用同一环境，不依赖手写 PYTHONPATH。不要重新安装依赖或新建环境；缺依赖请报告。',
  '对照固定提交和输入，逐项核对实际命令、输出、截图、持久化读回及失败路径；静态检查不能替代保存重开等用户行为。',
  '交付源码与原图只读。平台已提供可写的测试运行目录和 /tmp，可启动临时服务、写隔离数据库及报告，不写共享业务数据。先读取旧证据，保留已通过项，实际补做新输入的缺失链路；不要只复述旧报告，不要再要求用户搬图或发送 resume。不要创建 PLAN/HANDOVER。',
  '若有新材料，实际补验尚未覆盖的链路，不能只复述旧报告或用旧输入冒充新输入。可在测试运行目录创建补验驱动，调用固定源码；若仓内测试入口写死源码输出路径或缺少新输入支持，报告为范围内测试入口缺陷，交回实施者，不要求用户申请全仓写权限。',
  '先给可读报告，区分已测通过、缺陷与未测；缺少必要证据不能批准。',
].join('\n');
