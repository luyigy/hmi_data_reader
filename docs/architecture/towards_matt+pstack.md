# agent-platform-v2 近期代码审查：自动推进与 pstack 整合诊断

我检查了你 GitHub 私有仓库 [luyigy/agent-platform-v2](https://github.com/luyigy/agent-platform-v2?utm_source=chatgpt.com) 的最新 `oss-prep` 分支，基线是 2026 年 10 月 19 日的 `79ffef0`，重点阅读了任务图协调器、阶段工作器、执行 Prompt、自动回修、Issue 标签约定，以及 10 月 18–19 日的可靠性修复记录。

先给你一个关键判断：

你现在的平台已经有 Matt Pocock 工作流的部分需求和 Ticket 机制，也有 pstack 风格的 Architect、独立验收和回修，但还没有看到一个真正完整、可观察的 Gardening 闭环。

更重要的是，你的两个困扰实际上属于两个不同层次：

- Ticket 经常卡住：主要是执行生命周期、失败分类、运行环境、检查和状态恢复的问题。
- 感受不到 pstack 的持续进化：是因为“完成任务”与“把本次错误沉淀为未来的工程约束”尚未形成明确的闭环。

## 一、你的系统目前发展到哪一步？

根据已检查代码与文档的能力评估

Matt：Spec / Ticket / Issue

已有结构和实际 GitHub/Gitee Issue 接入；仍有端到端能力未验收

任务图：并行、依赖、自动接力

已有真实实现和大量可靠性修复，稳定性仍在验证

pstack：Architect 审查

明确接入审查指令和独立架构复核

pstack：验证、失败回修

已有检查器、独立验收和有限回修

pstack：Gardening / Wire

存在工程约束实例，但未看到独立的纠错沉淀闭环

这是实现成熟度的定性评估，不是自动化测试的通过率，也不代表对生产运行状态的实时审计。

### 我在真实代码中发现的关键证据

| 文件                                     | 实际发现                                        | 我的判断                     |
| -------------------------------------- | ------------------------------------------- | ------------------------ |
| `task-graph/prompts.ts`                | 明确写有“按 pstack architect 的模块边界、信息归属和影响面原则检查” | Architect 主要通过 Prompt 接入 |
| `task-graph/repair.ts`                 | `MAX_AUTO_REPAIR_ATTEMPTS = 2`，范围内缺陷可触发回修   | 已有有限自动回修                 |
| `task-graph/coordinator.ts`            | 持有实施、检查、集成、架构、验收及恢复流程                       | 核心执行协调器已存在               |
| `task-graph/phase-worker.ts`           | 检查任务归属、worker 身份和进程退出状态                     | 已考虑重启和重复执行安全             |
| `task-graph/execution-instructions.ts` | 把批准的检查命令注入执行任务                              | 有任务级验证入口                 |
| `docs/agents/triage-labels.md`         | 定义 Ticket 执行状态，但明确说明标签尚未持续自动同步              | Issue 可见状态与账本未完全对齐       |

对应源码：[prompts.ts](https://github.com/luyigy/agent-platform-v2/blob/oss-prep/src/lib/task-graph/prompts.ts?utm_source=chatgpt.com)、[repair.ts](https://github.com/luyigy/agent-platform-v2/blob/oss-prep/src/lib/task-graph/repair.ts?utm_source=chatgpt.com)、[coordinator.ts](https://github.com/luyigy/agent-platform-v2/blob/oss-prep/src/lib/task-graph/coordinator.ts?utm_source=chatgpt.com)。

这里需要强调：你并不是没有做 pstack 的事情，而是主要实现了它的任务执行和质量审查部分，还没有把“持续改良代码仓库”显式做成一个产品能力。

## 二、为什么 Ticket 会经常卡住？

你仓库的这份文档很重要：

[task-graph-reliability-draft.md](https://github.com/luyigy/agent-platform-v2/blob/oss-prep/docs/architecture/task-graph-reliability-draft.md?utm_source=chatgpt.com)

它事实上已经对问题做过一次比较深入的分析。

其中记录过一个非常典型的案例：

Agent 在可以写入的 Worktree 中实施代码，测试成功；平台却在只读沙箱里运行检查，测试需要向固定目录写报告，于是失败。平台将它标记为需要处理，整个依赖链无法向前推进。

另一种情况是模型返回的结构化结论不完整，平台把它当成执行失败。

这些都不意味着业务代码一定有问题。

历史 R01 故障类型示意，并非最新线上运行状态。一个共享前置节点被暂停，会导致其所有后继等待。

你最近的修复已经开始触及这些根因：

- [d2ccdc2](https://github.com/luyigy/agent-platform-v2/commit/d2ccdc25eeced31e32695ba121203b44016ef773?utm_source=chatgpt.com)：保留 PostgreSQL、网络等临时故障的原始错误类型，使平台可以有限重试。
- [8cb6a7f](https://github.com/luyigy/agent-platform-v2/commit/8cb6a7f812325f8c2b2ad96c57e120155d7c1ffa?utm_source=chatgpt.com)：处理集成后验收接续、合并冲突恢复和进程退出后的状态接管。
- [79572b4](https://github.com/luyigy/agent-platform-v2/commit/79572b4d54cba002e27970a845db7a77ed3b3161?utm_source=chatgpt.com)：处理冲突修复产物位置和运行环境错误包装。
- [77ff1da](https://github.com/luyigy/agent-platform-v2/commit/77ff1da75357f2cc7af09b60def8d6a989c94f3d?utm_source=chatgpt.com)：明确自动处理次数耗尽后由平台还是用户承担下一步责任。

这说明开发方向已经越来越接近正确的执行生命周期设计。

但我认为你当前还需要解决一个更深层的问题：

每次发生故障之后，你都在修复某个具体故障，却缺少一个统一入口告诉你：这是什么类型的问题、为什么反复出现、这次究竟增加了什么永久防线。

这正好是 Gardening 应该提供的能力。

## 三、pstack 的“铁丝”其实已经出现过，只是你没有把它认出来

从你最近的提交来看，你已经做过几次非常典型的 Gardening。

例如最近的 `b4dee81`：

原来飞书服务启动清理时，会把其他协调器管理的任务也标记为 completed，尽管其原生 Agent 进程仍然运行。

你没有简单地告诉 Agent “以后不要这么做”，而是：

1. 将清理逻辑收敛到明确的 `cleanupFeishuOwnedStaleTaskRuns`。
2. 规定飞书服务不能修改任务图协调器所属的 TaskRun。
3. 增加回归测试，复现旧错误并验证新实现。
4. 保留相关审计记录。

这就是一根真正的 Wire！

真实案例：跨服务状态归属错误

错误：飞书服务清理了任务图运行状态

原则：每个运行状态只能由其明确的 Owner 修改

Wire：限定清理函数 + 所有权验证 + 回归测试

今后同类错误可以被自动检测

依据仓库可靠性验证记录。未来检查是否真正挡住所有变体，仍取决于测试覆盖和运行门禁。

现在的问题是，这根 Wire 没有进入一个可查询的 Gardening 账本，也没有在 Ticket 完成时明确展示出来。

你看到的是“修复了某个 Bug”，而不是：

> Gardening #12：发现状态所有权缺陷，增加跨服务写入约束，关联 3 个回归测试。下一次同类违规将被 CI 检测。

这两个表达的产品体验完全不同。

## 四、我建议你把完整工作流设计为两个闭环

上半部分是已有系统能力的抽象；虚线区域是建议新增的显式学习闭环。

这里有一个很重要的设计判断：

不要要求每个 Ticket 必须生成一根新的 Wire。

正常业务实现可能没有发现值得永久沉淀的问题。Gardening 应该检查是否有教训，而不是强制制造规则和测试。

反过来，即使 Ticket 最终失败、需要人工处理，也可能已经发现一个应该优先修复的平台级问题。

因此，Gardening 可以与 Ticket 完成解耦，不应该成为所有后继 Ticket 的新阻塞条件。

## 五、建议分三个很小的 Slice 来完善

G01 — Ticket 自动推进可靠性

先完成当前 WR01–WR07 的真实端到端验收，不再另造调度器。

每个 Ticket 都必须能显示当前阶段、最后一次失败、下一次自动动作、重试预算，以及是否真的需要人决策。

验收：故意让一个检查失败一次，系统自动回修、重新检查、验收并放行后继，人工 resume 次数为零。

G02 — Gardening 事件与教训记录

复用已有 `TaskGraphEvent` 和 Git/检查证据，增加一个后处理 Skill。

它负责回答：这次错误是否重复？根因是什么？属于平台、业务代码还是 Agent 工作方法？是否已有永久防线？

验收：拿已有的“飞书错误清理 TaskRun”案例运行分析，生成一份可追溯的 Gardening 报告。

G03 — Wire 生成、验证与可视化

把被确认的重复错误转成仓库中的约束：架构调整、类型限制、Lint 或自动化测试。

由 Agent 提议，受控实施，独立 Verifier 验证。只有证实旧错误能够被拦截后，才能标记为 Active Wire。

验收：故意重新引入历史错误，检查必须失败；恢复正确代码后检查通过，并能从飞书看到对应 Wire、检查入口和提交证据。

### 我希望你最终在飞书看到这样的东西

Ticket R02 · 执行与 Gardening

界面原型

业务交付：已完成并通过验收

本次工程改良

WIRE-012 · 跨服务状态所有权

发现原因：Feishu 启动清理错误处理 TaskGraph 的 TaskRun。

已添加针对历史错误的回归测试

错误场景被检测，正确场景通过

已关联代码提交与验证记录

本次新增 Wire：1 · 复用已有 Wire：2

示意数据

这样你才真的能看到代码花园是如何被修剪、加固和逐步演进的。

## 六、一个值得立即检查的设计细节

目前 `prompts.ts` 的实现说明了一个潜在的问题：

你的 Architect 明确遵循 pstack 的架构原则，但实施 Agent 的 Prompt 主要是在要求其按 Ticket 开发、保留证据、运行检查；验收 Agent 也主要依据 Spec、Ticket 和 verify Skill。

我没有在检查过的核心执行 Prompt 中看到明确的 `/correct` 触发、重复错误归类、Wire 生命周期或 Gardening 结果记录。

因此：

现在的 pstack 更像是被作为“角色指导原则”引入，而不是作为一套能够积累工程改进的持续反馈机制。

这并不意味着其他未检查路径中一定不存在类似功能，但至少在任务图主执行路径里，还没有形成可以向你展示的完整链路。

你完全不需要把整个 pstack 原封不动搬进平台。最值得保留的是它的三个能力：

1. Architect 在实施前和交付后检查边界。
2. Verifier 用真实可复现的测试证明交付。
3. Gardener 把重复错误变成永久工程约束，并验证约束有效。

其中第三项才是你目前感受不到的部分。

## 七、我建议你的下一步

优先做 G01，然后做 G02 和 G03。不要现在就把注意力转移到更多的 Agent 角色、Skill 或全新 Orchestrator 上。

你已经有 `ExecutionProgress`、`ExecutionOutcome`、持久化事件、回修预算、工作区所有权和独立验收机制。这些是非常好的基础，继续整合比推倒重建更合适。

我会把最终目标定义为两个可衡量的指标：

自动推进能力： 有多少 Ticket 在不需要人工介入的情况下完成批准的交付和验收，以及每次暂停真正归因于什么。

Gardening 能力： 有多少经过证实的重复错误被转成可执行的防线，以及这些防线在后续提交中实际拦截过多少次违规。

特别是第二项，不建议用“新增了多少条 AGENTS.md 规则”衡量，因为那可能恰恰意味着软约束越来越膨胀。

你的目标应该是：

Matt Pocock 负责让 Agent 知道要做什么，pstack 负责让 Agent 以可验证的方式做好，并让代码仓库从过去的错误中变得更可靠；agent-platform-v2 负责把这些环节稳定、可恢复、可观察地连接起来。

目前你距离这个目标已经不算遥远。真正需要补的不是更多概念，而是自动推进的最后一段可靠性，以及一个明确可见的 Gardening 反馈闭环。