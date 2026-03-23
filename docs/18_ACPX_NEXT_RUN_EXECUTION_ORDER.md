# 18 ACPX 下一轮实施顺序摘要

## 日期
2026-03-23

## 目的
这份文档不是新的产品方案，而是把以下三份规划文档收敛成“下一轮开发该怎么落地”的执行摘要：

1. `docs/14_ACPX_TASK_RUNNER_PLAN.md`
2. `docs/16_ACPX_INTERACTIVE_RUN_CONTROL_PLAN.md`
3. `docs/17_ACPX_TASK_SESSION_AND_MULTI_TASK_DECK_PLAN.md`

目标是让下一轮开发时不再重复讨论“应该先做什么”，而是按一个清晰、稳定、风险可控的顺序推进。

## 当前总判断
ACPX 已经不应该再被理解为“任务创建 + 执行日志页面”的功能点。

下一阶段应明确把 ACPX 视为三层能力：
- `Task Runner`
  负责一次 run 的执行与事件流
- `Task Room`
  负责用户、参与方、运行控制、上下文沉淀
- `Task Deck`
  负责同时观察与切换多个活跃任务

并且在架构上，需要逐步引入：
- `TaskSession`
- `TaskRunControlMessage`
- `ACPX Runtime Adapter`

## 已锁定的方向

### 1. ACPX 是平台执行模式，不是普通 agent 名称
这一点已确定，不再回退到：
- 名称匹配
- `codex / claude / all` 这种旧路由逻辑

### 2. `/tasks/[id]/chat` 的目标形态是 task room，不是纯 console
后续所有相关实现都应围绕这个目标推进。

### 3. timeout 不是主要失败逻辑
后续需要把 timeout 从“硬编码失败条件”改成：
- 可选 watchdog
- 用户可理解的运行策略
- 与活动状态分离的运行保护配置

### 4. 用户消息必须区分 queued 与 immediate
不能继续把所有用户消息都当成一样的输入。

### 5. 平台未来不能只依赖 OpenClaw 作为远端 agent 激活路径
OpenClaw 当前是一个重要 adapter，但不应等于平台 ACPX runtime 本身。

### 6. direct harness 必须是可写且可交互的
这一点现在应视为锁定方向：
- direct `codex` / `claude code` 不能只是“能跑起来”
- 必须能：
  - 写代码
  - 请求用户确认/输入
  - 在 task room 中等待用户后继续

## 下一轮总原则

### 原则 1：先稳固抽象，再扩 UI
不要继续先加按钮、再想语义。

下一轮应该优先把：
- session
- control action
- activity state
- capability matrix

这些抽象层先固定。

### 原则 2：先做可控的本地链路，再推广到远端
本地 Codex / Claude 的 child process 生命周期更容易控制，所以：
- interrupt
- stop
- restart with injected context

应先在本地打通。

远端 gateway / OpenClaw 先通过 capability 适配，不要先承诺一致行为。

### 原则 3：先做 Task Room 的交互闭环，再做多任务总控
Task Deck 很重要，但如果单个 task room 的交互语义不稳，总控页也会变成空壳。

所以：
- Task Room 交互闭环优先
- Task Deck 只读摘要可并行，但控制能力不要先超前

## 推荐实施顺序

## 阶段 A：数据与类型抽象先行

### A1. 引入 `TaskSession`
这是下一轮最重要的结构变化。

原因：
- 一个 task 不会只有一次 run
- 用户会在多次 run 之间持续讨论
- 参与方可能在任务中途新增
- “邀请协助 agent” 不能只挂在某一轮 run 上

建议最低落地内容：
- Prisma schema 增加 `TaskSession`
- `Task` 到 `TaskSession` 的关联
- 一个 task 当前默认只有一个 active session

### A2. 定义交互控制类型
在类型层加入：
- `RunControlAction`
  - `queue_message`
  - `interrupt_now`
  - `stop_run`
- `RunActivityState`
  - `streaming`
  - `quiet`
  - `stalled`
  - `waiting_user`
  - `terminating`
- `HarnessCapability`
  - `supportsQueuedUserMessages`
  - `supportsImmediateInterrupt`
  - `supportsResumeAfterInterrupt`
  - `supportsLiveSessionControl`
  - `supportsSoftStop`

落点建议：
- `src/lib/acpx/types.ts`
- 视情况拆到：
  - `src/lib/acpx/control.ts`
  - `src/lib/acpx/capabilities.ts`

### A3. 设计 `TaskRunControlMessage`
这一步不要省略。

如果没有这层，后面 room message 与运行控制会永久混乱。

建议最低落地内容：
- Prisma schema 增加 `TaskRunControlMessage`
- 定义和普通 room message 的关系
- 支持：
  - queued
  - immediate
  - stop request

## 阶段 B：先打通本地 harness 的交互控制

### B1. 本地 Codex / Claude 支持 stop / interrupt
先不要要求“完美 mid-run prompt injection”。

优先目标应是：
- 能中断
- 能停止
- 能在中断后以新上下文重新启动

这已经足够支撑第一版：
- 立即介入
- 紧急停止

### B2. 建立 activity state 更新机制
不要再只用 timeout 做判断。

需要开始记录：
- `lastActivityAt`
- `lastStdoutAt`
- `lastStderrAt`
- `activityState`

这样前端才能显示：
- 正在输出
- 安静工作中
- 长时间无活动

### B3. timeout 改为 watchdog config
这一轮不一定要把完整 UI 一起做完，但至少不要继续扩大硬编码 timeout。

建议改为：
- schema / type 支持 `watchdogConfig`
- runner 支持读取：
  - `maxRuntimeMs`
  - `inactivityWarningMs`
  - `inactivityFailMs`

先做内部 contract，UI 后补也可以。

### B4. 解决 direct harness 的可写环境
这一阶段必须补上：
- writable workspace contract
- permission / approval mode contract
- repo trust / working directory contract

如果 direct harness 仍然输出“当前会话是只读环境，无法修改仓库”，那 ACPX 还没有真正进入可用的 coding 阶段。

### B5. 把 harness 主动请求用户输入建模成 first-class flow
需要开始定义并接入：
- permission request
- confirmation request
- choice request
- freeform input request

以及对应状态：
- `waiting_for_input`
- `needs_user_input`

这一步不能再被 timeout 逻辑掩盖。

## 阶段 C：Task Room 交互闭环

### C1. 把 room message 与 control message 接起来
用户在 task room 的输入，需要能显式选择：
- 排队发送
- 立即介入

平台行为要不同，不只是 metadata 不同。

### C2. 支持“立即介入”后的执行语义
推荐第一版行为：
- 本地 harness：
  - interrupt 当前 run
  - 把最新用户消息与已有上下文合并
  - 启动下一段执行
- 不支持 interrupt 的远端 harness：
  - 标记 control request pending
  - 在下一阶段生效

### C3. 让 task room 可以指定消息目标
至少应支持：
- 面向整个 task
- 面向某个 participant

否则后续“与 implementer 讨论 / 请 reviewer 帮忙看一下”无法自然表达。

### C4. 明确系统消息与用户消息的边界
现在很多消息都被放进 room 或 event 流里。

下一轮应明确区分：
- 用户讨论消息
- 运行控制消息
- 系统状态消息
- participant 消息

### C5. 支持用户响应 harness 请求
除了用户主动发 queued/immediate 消息，task room 还应支持：
- 回复 harness 的权限确认
- 回答 harness 的输入请求
- 在候选选项中做选择

这会是 direct harness 真正“像一个可协作 coding room”而不是“后台 CLI 包装器”的关键一步。

## 阶段 D：邀请协助 agent

### D1. 先支持“加入讨论”
推荐先做这个，而不是直接做“加入执行”。

原因：
- 语义更简单
- 风险更小
- 能先满足用户“agent 卡住时请另一个 agent 来帮忙分析”的核心诉求

### D2. 再支持“加入执行”
等 `TaskSessionParticipant` 模型稳定后，再支持：
- 加入下一轮 run
- 加入后续阶段

### D3. 不要把邀请逻辑绑死在 OpenClaw
邀请动作应针对“平台可调度的 agent 能力”本身，而不是 OpenClaw 特定接口。

## 阶段 E：Task Deck 多任务总控

### E1. 先做只读总控页
优先做：
- 活跃任务列表
- attention badge
- 最近消息/最近事件预览
- tab 或列表切换

### E2. 再做快捷控制
等 Task Room 控制语义稳定后，再加：
- 快速发送消息
- 快速中断
- 快速停止

### E3. 最后再考虑多任务并排视图
不要一开始就做复杂布局。

先做：
- 单页 tabs
或
- 左侧列表 + 右侧详情

足够支撑真实使用。

## 阶段 F：平台原生 ACPX Runtime 方向

### F1. 先抽象 adapter 接口
这一步不是马上做完平台原生 runtime，而是先把接口收口。

建议抽象的能力：
- `startRun`
- `streamEvents`
- `sendQueuedMessage`
- `interruptRun`
- `stopRun`
- `getCapabilities`

### F2. 先有两种 adapter
- `Local CLI Adapter`
- `OpenClaw Adapter`

### F3. 后续再引入平台托管 worker
这不是下一轮必须完成的内容，但下一轮的接口设计必须给它留位置。

## 下一轮不建议做的事

### 1. 不要先做复杂自动智能诊断
例如：
- 自动 loop detection
- 自动建议邀请 reviewer
- 自动策略切换

这些后面都值得做，但前提是 session / control / activity 先稳。

### 2. 不要先承诺所有 harness 都能 mid-run 实时插话
应该由 capability matrix 决定实际支持程度。

### 3. 不要先做复杂多窗口/多列自由布局
Task Deck 先做可用，再做高级布局。

## 建议的最小下一轮交付物
如果下一轮只做最关键的最小闭环，建议目标是：

1. Prisma 新增：
- `TaskSession`
- `TaskRunControlMessage`

2. ACPX 类型新增：
- control action
- activity state
- harness capability
- watchdog config

3. 本地 harness 支持：
- stop
- interrupt
- restart with injected context

4. Task Room 支持：
- 排队发送
- 立即介入
- 停止运行

5. Task Deck 初版：
- 活跃任务列表
- 状态摘要
- attention badge
- tab 切换

## 为什么这个顺序最稳
- 先加 `TaskSession`，避免继续把 run 和 room 混在一起
- 先加 control message，避免用户消息语义失控
- 先打通本地 interrupt/stop，尽快形成真实可控闭环
- 先做 Task Room 控制，而不是直接上多任务复杂交互
- 最后再接 Task Deck，能复用已稳定的 room/session/run 模型

## 下一轮开发时的优先阅读顺序
1. `docs/14_ACPX_TASK_RUNNER_PLAN.md`
2. `docs/15_ACPX_TASK_RUNNER_HANDOVER.md`
3. `docs/16_ACPX_INTERACTIVE_RUN_CONTROL_PLAN.md`
4. `docs/17_ACPX_TASK_SESSION_AND_MULTI_TASK_DECK_PLAN.md`
5. `docs/18_ACPX_NEXT_RUN_EXECUTION_ORDER.md`

## 最终结论
下一轮真正应该做的，不是继续堆更多控制台细节，而是：
- 把 ACPX 的 session 层立住
- 把运行控制语义立住
- 让 task room 变成可介入的工作空间
- 再把多个任务聚合到 Task Deck

这将决定 ACPX 后续是一个“可持续扩展的交互式平台能力”，还是继续停留在“加了很多按钮的任务日志页”。
