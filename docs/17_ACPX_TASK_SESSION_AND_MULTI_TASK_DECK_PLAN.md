# 17 ACPX Task Session 与多任务控制台方案

## 日期
2026-03-23

## 目标
在现有 ACPX task runner 与交互式运行控制方案基础上，进一步把平台演进成：
- 可同时查看多个运行中任务
- 可随时切换并介入任意任务
- 可与任务中的参与方持续讨论
- 可在任务中途邀请其他 agent 协助
- 不完全依赖 OpenClaw 才能激活/连接平台可访问环境中的 agent

这个方案关注的是 ACPX 的上层产品形态与中层运行抽象，而不只是某一个 task run 的事件流。

## 为什么需要这份方案
如果只围绕 `/tasks/[id]/chat` 单页继续迭代，会有几个结构性问题：
- 无法优雅支持多个任务同时运行时的统一观察与控制
- 用户在一个任务里切走后，很难知道另一个任务是否需要立刻处理
- “讨论”“运行”“再次运行”“新增协作 agent” 这些行为会被混在一条 run timeline 里，语义越来越乱
- 当前 ACPX 过度依赖：
  - 本地 CLI harness
  - OpenClaw 暴露出来的远端 agent
- 这不满足平台未来要“原生拥有 ACPX 能力”的目标

所以这里需要明确把产品与架构分成三个层次。

## 三层目标模型

### 第一层：Task Room
一个任务对应一个长期存在的交互空间。

它负责：
- 用户与参与方持续对话
- 查看当前与历史运行
- 用户发送 queued / immediate 消息
- 紧急中断
- 邀请新 agent
- 沉淀整个任务的上下文

Task Room 不应等于一次 run。

### 第二层：Task Deck
一个页面集中呈现多个活跃任务。

它负责：
- 同时观察多个 running / waiting / stuck task
- 标签切换或多列布局
- attention badge
- 快速进入某个 task room
- 快速发送一条指令到某个任务
- 快速停止或中断某个任务

Task Deck 是用户的总控视角。

### 第三层：ACPX Runtime
平台内部的 ACPX 运行时抽象。

它负责：
- session 管理
- participant 编排
- message routing
- run lifecycle
- control actions
- harness capability discovery
- 适配不同 agent 来源

这个 runtime 未来不应该只等同于 OpenClaw adapter。

## 核心产品问题

### 1. 一个任务不应只等于一条 run
现实中的任务通常会经历：
- 初始讨论
- 第一次运行
- 用户纠偏
- 第二次运行
- 发现卡点
- 邀请另一个 agent 帮忙
- 新一轮讨论
- 第三次运行

因此更合理的关系应当是：

```text
Task
  └── TaskSession
        ├── Room Messages
        ├── Participants
        ├── TaskRuns[]
        ├── Control Messages[]
        └── Session State
```

### 2. 用户需要同时看多个任务
目标不是只有一个任务的精细页，而是：
- 多个任务同时 live
- 用户在总控页中快速判断哪里需要自己介入

这意味着 Task Deck 需要首先支持：
- 活跃任务列表
- 每个任务的状态摘要
- 最近事件预览
- attention 指示
- 未读消息计数

### 3. “邀请其他 agent 帮忙”必须是 first-class action
这里不能只是修改 participant 数组这么简单。

因为邀请可能有两种不同语义：

#### 邀请加入讨论
agent 只加入 task room，对任务提供建议，不立刻参与执行。

#### 邀请加入执行
agent 成为下一阶段或下一次 run 的正式 participant。

这两者必须在产品与数据模型上分开。

### 4. 平台不应完全依赖 OpenClaw 作为 agent 激活入口
当前平台调用远端 agent 的主要路径依赖：
- OpenClaw `/v1/responses`
- OpenClaw 控制面

这在 Phase 1 可接受，但长期看有明显限制：
- 如果某台机器上有我们能访问的 agent/harness，但它没有暴露 OpenClaw 兼容面，平台就无法统一纳管
- ACPX 运行控制能力会被外部系统能力边界绑死

所以需要引入“平台原生 ACPX runtime + adapter”思路。

## 关键概念建议

### 1. `TaskSession`
建议新增这一层，而不是继续把所有东西都塞进 `TaskRun`。

建议字段：
- `id`
- `taskId`
- `status`
  - `active`
  - `waiting_user`
  - `paused`
  - `completed`
  - `failed`
- `attentionState`
  - `normal`
  - `needs_review`
  - `needs_user_input`
  - `stuck`
  - `error`
- `activeRunId`
- `summary`
- `metadata`
- `createdAt`
- `updatedAt`

### 2. `TaskSessionParticipant`
表示一个长期参与该任务会话的 agent 或 harness 参与方。

建议字段：
- `id`
- `taskSessionId`
- `gatewayId`
- `harnessType`
- `agentId`
- `role`
- `participationMode`
  - `discussion`
  - `execution`
  - `both`
- `status`
  - `active`
  - `invited`
  - `removed`
- `metadata`

### 3. `TaskRun`
`TaskRun` 继续表示一次具体执行。

但它应该从属于 `TaskSession`，而不是独立承担全部语义。

建议新增：
- `taskSessionId`

### 4. `TaskSessionMessage`
虽然当前已有通用 `Message`，但长期最好有 session 级别语义。

如果暂时不新增表，也建议在通用消息上增加 metadata 约定，区分：
- 用户讨论消息
- 系统消息
- 参与方消息
- 运行控制消息
- agent 邀请消息

### 5. `TaskRunControlMessage`
这个概念已在 `docs/16` 中提出，建议继续保留。

### 6. `AgentCapabilitySource`
未来平台需要能区分 agent 来源：
- `platform_local_cli`
- `openclaw_gateway`
- `platform_managed_worker`
- `direct_remote_runtime`

这样 ACPX runtime 才能逐步摆脱“OpenClaw 即全部远端能力”的假设。

## Task Deck 产品方案

### 页面目标
提供一个总控页面，让用户能同时掌握多个任务。

建议页面形态：
- 左侧：活跃任务列表
- 中间：当前选中任务的 room + run 状态
- 右侧：任务详情 / participants / quick controls

或第二种形态：
- 顶部 task tabs
- 下方当前 task room

### 每个任务卡片至少显示
- 任务名
- 当前 session 状态
- 当前 run 状态
- 最近活动时间
- 最近一条关键消息 / 关键事件
- attention badge
- 当前参与方数量
- 是否有用户未处理事项

### attention badge 建议
- `正常`
- `运行中`
- `等待用户`
- `卡住`
- `失败`
- `有新消息`
- `需要复核`

### 快捷动作建议
从 Task Deck 上直接提供：
- 打开任务
- 发送快速消息
- 紧急中断
- 停止运行
- 邀请 agent

## Task Room 产品方案补充

### 讨论区与执行区要分区
一个 task room 中至少要分成两个区域：

#### 讨论区
- 用户消息
- 参与方讨论
- 系统建议
- 邀请/加入消息

#### 执行区
- 当前 run console
- participant 输出
- 状态流

否则用户会感觉所有内容都混在一起，难以理解。

### 用户要能和“指定 agent”说话
不是所有消息都应广播给所有参与方。

建议支持：
- `对整个 task room 说`
- `只对 implementer 说`
- `只对 reviewer 说`
- `邀请某个新 agent 并对它发第一条消息`

### stuck loop 场景要成为正式交互
用户提到的“agent 一直重复同样错误”非常关键。

平台未来应具备：
- loop risk 提示
- 提示用户：
  - 是否中断
  - 是否邀请 reviewer/help agent
  - 是否要求 agent 先总结现状再继续

## 邀请其他 agent 协助的流程设计

### 场景 A：邀请加入讨论
流程：
1. 用户点击 `邀请协助`
2. 选择：
  - gateway
  - harness
  - agent
  - role
3. 选择 `加入讨论`
4. 平台把该 agent 作为 `TaskSessionParticipant(participationMode=discussion)` 加入
5. 房间内出现系统消息：
  - 某 agent 已加入讨论

### 场景 B：邀请加入执行
流程：
1. 用户点击 `邀请协助`
2. 选择 agent
3. 选择 `加入执行`
4. 平台可提供两种模式：
  - 加入下一次 run
  - 加入当前 session 的下一阶段

### 不建议的做法
- 不要让“邀请讨论”和“加入执行”共用一个模糊按钮
- 不要默认所有新 agent 都会立即开始跑

## 平台原生 ACPX Runtime 方向

### 当前局限
当前 ACPX 对 agent 的使用路径大致是：
- 平台本地 CLI
- OpenClaw 暴露的远端 agent

这意味着：
- session control 受外部能力限制
- mid-run intervention 很难统一
- participant 生命周期难以标准化

### 推荐方向
引入 `ACPX Runtime Adapter` 抽象。

建议接口方向：
- `startSession()`
- `startRun()`
- `sendQueuedMessage()`
- `interruptRun()`
- `stopRun()`
- `resumeRun()`
- `inviteParticipant()`
- `getCapabilities()`
- `streamEvents()`

### 初期 adapter 类型
#### Adapter A: Local CLI Adapter
- 管本地 Codex / Claude

#### Adapter B: OpenClaw Adapter
- 管当前 Gateway OpenClaw

#### Adapter C: Platform Managed Worker Adapter
- 未来平台自管 agent runtime

#### Adapter D: Direct Remote Adapter
- 未来如果某些服务器可直接连接但不走 OpenClaw

### 这样做的收益
- 平台不再把 OpenClaw 当成唯一远端 agent 入口
- control 语义可由平台统一定义
- 不同 agent 来源都能挂到同一套 ACPX session 上

## Token 消耗问题的产品与架构结论

### 问题本质
用户关注的是：
- harness 本身执行任务已经消耗一次 token
- 平台接收 live streaming 后，会不会再消耗同样一份 token

### 当前结论
通常不会因为“平台显示 live streaming”而再额外消耗一次同量 token。

原因：
- token 消耗发生在真正调用模型推理时
- 平台只是接收并存储已有输出流
- 把 stdout / stderr / event chunk 转发到前端，本身不是再次调用模型

### 什么情况下会额外消耗 token
只有当平台又做了额外的模型调用，才会新增 token 消耗，例如：
- 平台为了做自动摘要，再调用一次模型
- 平台为了做 loop detection，用模型分析日志
- 平台为了把长上下文压缩成 prompt，又调用模型
- 平台做“参与方讨论生成”时，本质上又发起了额外推理

### 规划 implication
所以后续文档里应明确区分：
- `stream relay`
  - 不额外产生模型 token
- `LLM-derived augmentation`
  - 会额外产生模型 token

## 推荐的交付顺序

### 第 1 步
先明确 `TaskSession` 模型。

### 第 2 步
做 Task Deck 的只读版：
- 多任务列表
- 状态摘要
- attention badge
- tab 切换

### 第 3 步
做 task room 的“邀请讨论 agent”

### 第 4 步
引入 ACPX runtime adapter 抽象

### 第 5 步
逐步把 OpenClaw 依赖收敛为 adapter，而不是平台核心语义本身

## 当前明确结论

### 结论 1
一个任务的长期协作空间应该叫 `TaskSession`，而不是继续让 `TaskRun` 承担全部语义。

### 结论 2
平台必须支持 `Task Deck`，以便用户同时观察与控制多个运行中任务。

### 结论 3
“邀请其他 agent 帮忙”必须成为 first-class flow，并区分：
- 加入讨论
- 加入执行

### 结论 4
平台未来的 ACPX 能力不应完全依赖 OpenClaw 暴露 agent。

### 结论 5
live streaming 转发本身通常不会双倍消耗 token。
真正额外消耗 token 的，是平台额外发起的模型调用。

## 建议阅读顺序
1. `docs/14_ACPX_TASK_RUNNER_PLAN.md`
2. `docs/15_ACPX_TASK_RUNNER_HANDOVER.md`
3. `docs/16_ACPX_INTERACTIVE_RUN_CONTROL_PLAN.md`
4. `docs/17_ACPX_TASK_SESSION_AND_MULTI_TASK_DECK_PLAN.md`
