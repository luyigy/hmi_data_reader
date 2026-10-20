我建议你直接把下面这份任务交给 Coding Agent。

重点是：不要让它马上重构整个 Task Graph，也不要让它继续针对 R05 增加特殊判断。先让它理解我们要改变的产品行为，再调查真正的阻碍，最后完成一个可验证的最小垂直切片。

你可以直接复制下面的内容：

# Task：恢复 Ticket Topic 中 Coding Agent 的正常自主工作体验

## 1. 背景与问题

仓库：`luyigy/agent-platform-v2`\
目标分支：`oss-prep`

开始前读取最新 HEAD 和仓库 `AGENTS.md`，不要假设 HEAD 仍是 `8b8970a`。

当前平台已经具备：

- Matt Skills → Spec → Tickets → 路线审批
- Task Graph 依赖编排、并行实施和恢复
- 每个 Ticket 对应的飞书 Task Topic
- ACPX / Harness 原生 Agent Session
- Git Worktree、Sandbox、架构复核、独立验收

但目前用户在 Ticket Topic 中与 Codex 对话时，体验不像正常 Coding Agent。

Agent 经常过度保守，容易暂停、要求人工确认，甚至需要使用特殊恢复协议才能继续工作。

当前系统将普通对话、只读 Followup、恢复交接和任务实施分成多条逻辑路径，导致用户虽然在同一个话题里聊天，却无法自然地与原执行 Agent 持续协作。

最近对 R05 的多次修复改善了个别问题，但我们不希望继续通过增加特殊情况判断来解决根本问题。

## 2. 核心产品目标

**Platform orchestrates tickets. Coding Agent autonomously executes each ticket.**

平台负责：

- 消费经过批准的 Spec 和 Tickets；
- 根据依赖关系并行或顺序调度；
- 管理 Worktree、Sandbox 和资源权限；
- 保证单 Writer、执行状态和恢复安全；
- 运行确定性检查、独立架构复核和验收；
- 在验收达到批准条件后自动解锁后继 Ticket。

Coding Agent 负责：

- 理解当前 Ticket 的目标和验收条件；
- 自主调查、编码、调试、测试和修复；
- 在原飞书 Task Topic 中自然地与用户交流；
- 接受图片、资料、纠正和补充信息；
- 在已批准范围内自主继续工作；
- 完成后提交候选成果，由平台验收。

**Task Topic 是原 Coding Agent 的持续交互入口，不是独立自治 Agent，也不需要第二套调度器。**

最重要的原则：

用户已批准 Ticket 后，Ticket 范围内的一般工程决策不需要重复请求人工批准。

Agent 不需要知道或向用户暴露 `claimKey`、`revision`、`waiting_decision`、`resume_implementation` 等内部机制。

但不能降低权限、安全、Writer 退出、批准范围、验收和预算等实质性约束。

## 3. 首先调查根因，不要立即编码

请从当前真实代码出发，追踪以下调用链：

1. Ticket 创建和派发 → `coordinator.ts` → `executeJob()`。
2. 原生 Coding Session → `implementationConversation()` → `executeAcpxTaskRun()`。
3. 飞书 Task Topic 输入 → Conversation Inbox → Steering / Followup。
4. `startConversationFollowups()` 中只读会话与实施恢复的关系。
5. `TASK_GRAPH_CONVERSATION` 控制行的产生、解析、授权与交接。
6. `waiting_for_user`、`answered`、`blocked`、`waiting_decision` 等状态之间的差异。
7. `prompts.ts`、`conversation-followup.ts`、Review 和 Harness Prompt 中导致 Agent 过度防御的要求。
8. 已有 Session 复用、Writer 隔离、恢复幂等及版本校验能力。

请重点回答：

- 哪些限制确实需要平台强制执行？
- 哪些是写在 Prompt 中、实际上让 Agent 自我约束的规则？
- 哪些正常用户消息被错误地解释成必须恢复或审批的操作？
- 为什么 Agent 在同一个 Task Topic 中不能像普通 Codex 一样继续工作？
- 能否利用现有的原生会话、Inbox 和 Coordinator 来解决，而不用再增加一套复杂的 Workflow？

请用具体函数、调用链、测试和提交证据说明结论。

## 4. 目标设计

希望 Ticket Topic 具有以下体验：

**场景 A：正常实施中的对话**

Agent 正在编码，用户发送问题或补充资料。

Agent 可以自然回复、吸收信息，并继续实施当前 Ticket，不因为普通问答而提前结束任务。

**场景 B：需要补充材料**

Agent 确实缺少必要材料，可以向用户提问并暂停。

用户补充材料后，平台在安全校验通过时自动接续原执行会话。

不要求用户手动输入特殊恢复命令。

**场景 C：用户纠正 Agent**

用户告诉 Agent 之前的判断有误。

Agent 应重新评估证据，允许纠正旧判断，在批准范围内继续工作，而不是把历史阻塞决定视为不可改变的事实。

**场景 D：Agent 自主修复**

编码或测试发现普通的范围内缺陷，Agent 应自主修复，而不是优先要求管理员或用户介入。

**场景 E：真正需要审批**

只有涉及批准范围扩大、资源权限变化、业务决策缺失、无法证明 Writer 安全退出等情况时，才要求人工介入。

对于 Writer 退出未知等安全问题，不得靠 Prompt 或时间猜测解除限制。

**场景 F：交付与验收**

正常聊天不能被视为交付。

只有 Agent 明确提交成果，平台才根据批准模式启动检查、架构复核和验收。

达到批准条件后才释放后继 Ticket。

## 5. 实施原则

请优先复用现有机制：

- `conversation-inbox`
- `conversation-session`
- `conversation-followup`
- `execution-progress`
- `coordinator`
- `acpx/runner`
- 现有 Writer Ownership 和 Recovery

不要新建：

- 第二套任务调度器；
- 第二套 Execution 状态机；
- 每个话题独立的自治 Agent；
- 新的全局恢复控制协议。

允许在必要时抽取小型、职责清楚的接口，但不能通过不断添加 Prompt 条款、状态特例、权限绕路和固定延迟来应付测试。

**优先将业务权限和状态约束落实在平台代码中，而不是依赖 Agent 自行遵守大量指令。**

不要简单删掉所有限制。要区分：

- 不应该限制 Agent 自主性的流程性约束；
- 必须继续由平台强制执行的安全和业务边界。

若现有执行已暂停，必须完成受控交接后才能重新获得写权限，不允许同时出现两个可写 Writer。

## 6. 最小可验证垂直切片

目标：**Normal Coding Agent inside Task Topic — S02**

请选择一个测试 Ticket，验证完整行为：

1. 通过已批准 Task Graph 派发到真实 Coding Agent。
2. Agent 启动原生 Coding Session，在独立 Worktree 中工作。
3. 用户在同一 Task Topic 发送普通问题，Agent 正常回答。
4. 用户补充信息或纠正错误判断，Agent 能理解并继续原任务。
5. 如果发生正常等待或暂停，平台安全、自动地恢复实施，不需要用户使用内部控制命令。
6. Agent 完成代码和测试后正式交付。
7. 平台按批准配置验收，并自动处理后继 Ticket。

测试必须覆盖：

- Session 上下文连续性；
- 无重复实施者或并发可写 Writer；
- 旧材料可引用，权限不扩大；
- 普通回答不等于交付；
- 任务恢复不错误消耗失败预算；
- 范围内缺陷能够自主修复；
- 真正越权操作仍被拒绝；
- 恢复与重复消息幂等；
- 崩溃和重启后不会丢失应执行的恢复意图。

请优先使用真实 Coordinator、PostgreSQL、Git 和 Harness 调用链。替身测试可以辅助，但不能单独证明用户体验已经修复。

## 7. 交付要求与停止条件

**第一阶段：只读诊断。**

先输出：

- 当前真实执行架构和问题根因；
- 自主性受限的位置与证据；
- 应保留的安全边界；
- 推荐的最小改动方案；
- 预计涉及的文件和接口；
- 可失败的验收测试设计；
- 为什么这个方案不会继续制造补丁。

第一阶段不要修改业务代码、恢复生产任务或部署服务。

等待用户确认方案后，再实施最小垂直切片。

第二阶段实施时：

- 先写出能够复现不自然交互的失败测试；
- 再修改代码；
- 以相同测试证明行为修复；
- 运行相关现有可靠性回归；
- 区分隔离测试与真实飞书、真实 Codex 验证；
- 不把测试替身的成功宣称为生产验证。

**最终验收标准：用户感觉自己在 Task Topic 里使用的是一个正常、聪明、能够自主完成工作的 Coding Agent，而不是不断要求人工审批的工作流机器人。**

平台的控制应该体现在可靠的执行、工程质量和正确的依赖推进上，而不是增加用户操作成本。

本任务不包含 Gardening 自动化、完整 Architect Inspector 或全仓 Feature-based 重构；这些留给后续独立 Slice。

