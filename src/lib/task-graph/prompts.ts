import { selfCheckExecution } from './domain';
import type { GraphDefinition, GraphNode } from './domain';

export function implementationInstructions(graph: GraphDefinition, node: GraphNode) {
  const autonomous = graph.deliveryContract === 'agent_commit_v1';
  return [
    `本次执行采用已确认任务图，模式 ${node.executionMode || 'full'}；Spec：${graph.specRef}。`,
    ...(autonomous ? [`批准的验收要求：${JSON.stringify(node.acceptance.checks)}。批准的整票命令：${JSON.stringify(node.acceptance.integrationChecks || [])}。由你自主执行实际验证，平台不会补跑；存在其他已批准 Gate 时仍须等待。`] : []),
    ...(graph.issueSource ? [`关联 Issue：${graph.issueSource.tickets.find((ticket) => ticket.key === node.key)?.ref}。Issue 范围与依赖已由平台校验，使用本次冻结的目标和指令；不要求在沙箱内读取宿主 tracker 凭据。`] : []),
    autonomous ? '只实施当前 ticket 范围，在指定 worktree 自主编码、自测、git add 和 git commit。最终报告完整 commit SHA，交付时工作区必须干净。不要改其他分支或主分支。平台不代提交、不代跑业务测试。' : '只实施当前 ticket 范围。在指定 worktree 编辑代码，汇报改动和实际验证证据。Git 元数据只读，由平台受控提交和集成；不要自行 git add/commit/merge。',
    '平台默认只读复用源项目已配置的 Python 环境，PATH 自动提供同一解释器和命令。不要另建虚拟环境、pip install --user 或修改共享依赖；缺依赖/版本冲突请明确报告，单独处理项目环境变更。',
    '使用本次任务图替代历史 PLAN/HANDOVER 接力要求；不要创建新的 PLAN/HANDOVER、next_action 或 WORKFLOW_READY。',
    '面向用户的进度每次用一至三句说明已完成什么、当前在做什么、是否需要用户处理；不用源码清单、哈希或审查原文充当进度。最终先给不超过三条的简明结论，详细技术报告写证据文件；结构化结论仍单独保留。',
    autonomous ? '平台只核验身份、版本、工作区与正式结果，并管理已批准的 Gate 和任务依赖；不要自行启动后继。' : '提交、自动集成、审查和后继派发由平台记录与执行；不要启动其他 Slice 或自行合并主分支。',
    autonomous ? '最终单独一行给出唯一正式结果：TASK_GRAPH_IMPLEMENTATION {"status":"delivered","commit":"完整 Git SHA","note":"实际交付说明","evidence":["实际自测与交付证据"]}。无需额外 ticketVerification；只有确实完成目标、自测并提交后才能 delivered。失败用 failed，阻塞用 blocked 并说明 blockerKind。' : '最终单独一行给出唯一结构化结论：TASK_GRAPH_IMPLEMENTATION {"status":"delivered","note":"实际交付说明","evidence":["实际文件、命令或读回证据"]}。只有确实完成本仓目标才能 delivered。',
    '在原会话直接处理用户补充，按原授权读取、修改和测试，不需要聊天转实施交接。普通文字答复会保存本轮并等待新消息；需要平台继续下一轮工作时，明确返回 TASK_GRAPH_IMPLEMENTATION {"status":"working","note":"下一步具体工作"}。明确等待用户时返回 status=waiting_for_user；范围或权限需要人决定时返回 status=blocked，并注明 scope_change 或 permission_required。',
    '必需运行能力确实不可用时返回 TASK_GRAPH_IMPLEMENTATION {"status":"blocked","blockerKind":"environment_failed","blockerCause":"missing_capability","note":"缺少的能力和实际探针结果"}。只读资源是否授权由平台校验，不自行扩大挂载；不要仅更换报告路径重复相同失败探针。',
    ...(graph.deliveryContract === 'agent_owned_v1' ? ['业务问题由你在当前会话与预算内修复并自测。最终结果使用 delivered、blocked 或 failed；失败返回 TASK_GRAPH_IMPLEMENTATION {"status":"failed","note":"实际失败原因和验证结果"}。blocked/failed 会停止本轮，平台不按业务错误分类重派实施者。working 仅表示你明确请求继续尚未结束的工作；waiting_for_user 仅用于确需用户输入。'] : []),
    graph.deliveryContract === 'agent_owned_v1' && node.executionMode !== 'implement'
      ? `质量责任已冻结：${node.acceptance.mode === 'agent' ? '配置的 Tester 对固定版本独立验证' : `各 execution 负责本仓自查；整票自查由 ${selfCheckExecution(node)} 在原 Coding Session 完成，以 delivered.ticketVerification 提交正式结论`}${node.acceptance.mode === 'human' ? '，之后等待人工批准' : ''}。批准的验收项：${JSON.stringify(node.acceptance.checks)}。平台只检查协议、身份、证据和版本一致性，不代跑业务检查。`
      : node.executionMode === 'implement'
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
  '交付源码与任务材料只读。平台已提供可写的测试运行目录和 /tmp，可启动临时服务、写隔离数据库及报告，不写共享业务数据。先读取旧证据，保留已通过项，实际补做新输入的缺失链路；不要只复述旧报告，不要求用户重复提供已有材料或发送恢复命令。不要创建 PLAN/HANDOVER。',
  '若有新材料，实际补验尚未覆盖的链路，不能只复述旧报告或用旧输入冒充新输入。可在测试运行目录创建补验驱动，调用固定源码；若仓内测试入口写死源码输出路径或缺少新输入支持，报告为范围内测试入口缺陷，交回实施者，不要求用户申请全仓写权限。',
  '先给可读报告，区分已测通过、缺陷与未测；缺少必要证据不能批准。',
].join('\n');
