# Matt 与 pstack 的本轮落地

本轮依据用户提供的 [诊断建议](towards_matt+pstack.md)，从 `79ffef0` 开始实施。Matt 的 Spec、Issue 依赖和飞书审批继续决定任务范围；pstack 用实际检查与独立复核证明结果。G01 优先，Gardening 作为后处理，不进入任务图的交付状态机。

## G01：自动推进与进度可见性

现有协调器已经具备自动回修、候选保存与依赖接续。本轮补齐的是原卡的阶段、下一自动动作和剩余额度，并修复只有 execution 更新、没有新 stdout 或 node 更新时卡片不刷新的问题。预算显示和执行判断复用同一常量，未增加重试次数。

在独立 PostgreSQL schema 中运行：

```sh
npm run test:task-graph-postgres -- task-graph-card-closure task-graph-auto-completion task-graph-execution-progress task-graph-review-repair task-graph-failure-summary task-graph-reply-summary
```

`auto-completion` 使用真实协调器、临时 Git 仓库和只读检查；Agent 与出站通知使用测试替身。首轮检查失败后，原票自动回修、独立支线完成、后继通过，人工恢复事件为零。`review-repair` 分别覆盖架构、验收及集成检查回修，成功兄弟不重新实施。它们提供隔离环境证据，不能替代商业 OCR 或整条业务路线验收。

卡片回归先命中 `false !== true`，证明无新 stdout 的阶段变化未触发刷新。审计后又在一次性副本中恢复旧判断，保存 [红色回执](../evidence/gardening/card-red-receipt.json) 和 [日志](../evidence/gardening/card-red.log)。修复后相同情形更新原卡，不另发新卡；没有变化时不重复更新。

WR07 继续保留真实业务观察及组合故障验收要求。本轮不会因这些测试通过而关闭 WR07、父单或暂停的业务票。实际服务没有重启，新的卡片逻辑尚未加载。

## G02：Gardening 后处理

仓内 [workflow-gardening skill](../../.agents/skills/workflow-gardening/SKILL.md) 规定取证、归因、复用防线、红绿验证和独立复核的顺序。首个 [TaskRun 归属报告](../gardening/taskrun-owner.md) 复用了真实事故证据和既有修复，没有要求每张票新增规则。

本版由 Agent 显式执行后处理，不自动监听每次交付，不向任务状态写入 Gardening 成败。没有新增表、Agent 角色或服务。报告失败也不暂停后继。

## G03：证明防线能拦住旧错误

运行：

```sh
node scripts/verify-taskrun-ownership-wire.mjs
```

脚本在自己创建的一次性目录中复制源码，移除旧事故涉及的单一归属守卫，再运行既有测试。只有失败确实是图任务被错误完成，才接收红色结果。恢复正确源码后，同一测试必须通过。临时数据库使用独立 schema，回执带源码及测试摘要。详细输出在 `output/gardening/`，已发布的本次回执在 [证据目录](../evidence/gardening/taskrun-owner/receipt.json)。

此处验证的是既有防线；没有为了增加 Wire 数量重复写测试。Active 状态还需独立复核，不能仅凭报告或脚本退出码宣称。后续新教训沿相同步骤提议、实施和验证；真实运行中拦截次数未测量。

本轮代码复核为未参与实现的独立 Codex 代理；审计为 `gpt-6-sol`。没有跨模型家族验证证据，不宣称满足跨家族多样性要求。决策记录的前四行集中回填，时间戳为记账时间，具体运行时间以测试回执为准。

## 发布与后续观察

本轮源码在隔离工作区开发和测试。发布 Git 提交不等于重启服务，不改变已有路线审批，也不自动恢复暂停节点。上线时沿用已确认的空闲加载边界，先核对实际写入者，再观察原群子话题的一张卡是否显示当前阶段、明确动作与预算。

持续 Issue 标签同步、自动触发 Gardening、把所有 Wire 嵌入进度卡，以及 WR07 的完整现场验收仍是后续范围。它们不是本轮已实现功能。
