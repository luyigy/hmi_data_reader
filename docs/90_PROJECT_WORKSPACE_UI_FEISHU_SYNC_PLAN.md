# 90 Project Workspace UI 与 Feishu Sync 设计方案

## 日期

2026-05-09

## 背景

当前系统在 Feishu 集成侧已经取得了明显进展：

- 可以通过 Feishu 驱动 room / live room / agent reply
- 可以把本地与远端 harness 接进同一条工作流
- 可以在 Feishu 里完成较大比例的真实协作

但回到 Web UI，整体体验仍然没有收敛成一个稳定、连贯的“工作台”：

1. Web 端的 room / task / live room 抽象仍然偏控制台式
2. Feishu 侧创建或推进的 room，并没有稳定、自然地同步成 Web 里的同一个对象
3. 用户无法像使用 Codex Desktop 一样，在左侧高效管理多个并行项目
4. 当前缺少统一的 attention / reminder 机制，用户不知道哪个项目需要自己介入

如果目标是接近 Codex Desktop 的体验，那么 Web UI 的主抽象必须从：

- “任务控制台”

收敛成：

- “项目工作空间（workspace）”

## 本文目标

设计一套适用于本项目的 Web 工作台模型，使系统支持：

1. 多个并行项目
2. 统一的项目列表和会话入口
3. Feishu / Web 双入口的一致数据模型
4. 清晰的“哪里需要我处理”的提醒系统

## 核心产品判断

### 一句话定义

**一个项目 = 一个 workspace = 一个主会话线程 = 一个可并行处理的单位。**

### 这意味着什么

以后在产品层面，不应该再把以下对象都作为“用户主视角对象”：

- task
- task room
- live room
- Feishu chat binding
- run

这些对象仍然可以保留，但它们应该退到内部实现层或附属层。

对用户来说，主视角对象应该只有一个：

- `Workspace`

## 目标用户体验

### 理想形态

参考 Codex Desktop 风格，Web UI 收敛成三栏布局：

1. 左栏：Workspace 列表
2. 中栏：主会话线程
3. 右栏：上下文 / 状态 / 控制面板

### 用户能做到的事

- 在左栏快速切换不同项目
- 在中间像聊天一样继续推进一个项目
- 在右栏查看成员、状态、绑定外部通道、等待处理事项
- 一眼知道哪些项目有新进展
- 一眼知道哪些项目需要自己回复、审批或补充信息

## 当前主要问题

### 1. 缺少 canonical workspace 模型

现在系统里有多个相近但不等价的对象：

- task
- task room
- live room
- Feishu conversation binding

这些对象之间虽然有关联，但还没有真正形成一个稳定的“主对象”。

后果就是：

- Feishu 那边推动的状态不一定自然反映到 Web
- Web 创建的内容也不一定自然表现为 Feishu 上的同一项目
- 前端页面很难围绕一个统一核心对象设计

### 2. Web 页面仍偏“运行控制台”

当前页面更像：

- 状态面板
- 运行控制面板
- debug 控制台

而不是：

- 项目工作台
- 会话式协作入口

### 3. Attention model 还没有成形

系统已经有不少“值得提醒用户”的事件，但这些事件还没有统一成前端可消费的工作信号，例如：

- agent 有新回复
- 有 pending approval
- 有 input request
- 某个 room 有新成员发言
- 某个项目失败了
- 某个项目仍在运行

没有统一 attention model，就做不好“并行项目工作”。

## 核心对象模型建议

## 1. Workspace

建议新增或收敛出的主对象：

```ts
Workspace {
  id: string
  title: string
  description?: string
  status: 'idle' | 'running' | 'waiting_for_you' | 'failed' | 'archived'
  lastActivityAt: string
  unreadCount: number
  attentionState: 'quiet' | 'new_updates' | 'waiting_for_you' | 'failed'
  primaryRoomId?: string
  sourceTaskId?: string
  linkedChannels: WorkspaceChannel[]
}
```

Workspace 是用户左栏里看到的一项。

### 重要原则

- `task` 不一定直接暴露给用户
- `live room` 不一定直接暴露给用户
- 用户主要感知到的是 `workspace`

## 2. WorkspaceChannel

用于表达外部入口或附属入口：

```ts
WorkspaceChannel {
  id: string
  workspaceId: string
  kind: 'web_room' | 'feishu_chat'
  externalId?: string
  status: 'connected' | 'disconnected'
}
```

Feishu 绑定应该被视为：

- Workspace 的一个外部 channel

而不是：

- 另一套平行 room 系统

## 3. WorkspaceMessage

用户主会话线程里的消息建议统一落成一类对象，区分 message type，而不是按来源分裂。

```ts
WorkspaceMessage {
  id: string
  workspaceId: string
  messageType: 'user' | 'assistant' | 'system' | 'control' | 'tool'
  senderType: 'user' | 'agent' | 'system'
  senderLabel: string
  content: string
  metadata?: object
  createdAt: string
}
```

### 原则

- Feishu 发来的消息也要归入同一条主时间线
- Web 发出的消息也归入同一条主时间线
- 不是两套 UI 各自维护一份“看起来差不多的会话”

## 4. WorkspaceAttention

建议把“提醒用户注意”的系统信号统一表达：

```ts
WorkspaceAttention {
  workspaceId: string
  state: 'quiet' | 'new_updates' | 'waiting_for_you' | 'failed'
  reason?: string
  updatedAt: string
}
```

## 页面信息架构建议

## 一、左栏：Workspace List

每个 workspace 一项，显示：

- 标题
- 最近一条预览
- 最后活动时间
- 当前状态
- 未读数
- 是否需要你介入

建议支持：

- pin
- archive
- search
- 仅看 active
- 仅看 waiting_for_you

### 左栏排序建议

优先级从高到低：

1. `waiting_for_you`
2. `failed`
3. `new_updates`
4. `running`
5. `quiet`

同类再按 `lastActivityAt desc`

## 二、中栏：主会话线程

这是整个产品的核心。

应该表现为：

- 一个持续的、可追踪的主线程
- 类似 Codex Desktop / ChatGPT 的主交互区

中栏需要做到：

- 用户消息自然出现
- agent 回复自然出现
- system 事件存在但不喧宾夺主
- approval / input request 有清晰卡片

### 不建议继续保留的做法

- 把大量 run / participant / session pill 长期堆在顶部
- 把聊天区搞成“控制面板式表格”

## 三、右栏：上下文与控制

右栏承载二级信息：

- workspace 成员
- 当前运行状态
- 绑定的 Feishu chat
- pending approvals
- source task / session 信息
- room settings

右栏默认可以展开，但应该支持折叠。

## Feishu / Web 同步原则

## 1. Feishu 不是“另一套主房间”

必须明确：

- Feishu 是 channel
- workspace 才是主对象

### 正确关系

- 一个 workspace 可以绑定一个或多个 Feishu chat
- Feishu 消息进入 workspace
- workspace 的关键状态变化也可同步到 Feishu

### 错误关系

- Feishu 自己维护一套 room
- Web 自己维护一套 room
- 两边靠零散映射“尽量像是同一个”

## 2. 需要一个 canonical id

必须保证：

- Feishu 创建/绑定出来的 room，最终能映射到一个稳定的 workspace id
- Web 端打开同一个项目时，拿到的是同一个 workspace id

否则无法做好：

- 左栏项目列表
- 未读
- attention
- 新消息定位

## 3. 同步方向必须清晰

建议定义清楚：

### Web -> Workspace

- 用户发送消息
- 用户审批 / 回答
- 用户修改设置

### Feishu -> Workspace

- Feishu 消息进入
- Feishu 触发 add member / mention / room binding

### Workspace -> Web

- 更新主会话
- 更新左栏状态
- 更新未读/attention

### Workspace -> Feishu

- agent 回复
- 系统状态提示
- 需要用户审批/确认的关键事件

## Attention / Reminder 设计

这是并行项目能力的核心。

建议最少定义四种状态：

### `quiet`

- 没有新消息
- 没有待处理事项

### `new_updates`

- 有新回复
- 你还没看

### `waiting_for_you`

- approval pending
- input request pending
- 需要你明确回复

这是最关键的状态，应该在左栏最醒目。

### `failed`

- 当前工作流失败
- 需要你介入决定下一步

## 推荐优先级

这里是关键判断。

目前你们同时有两个大方向：

1. HarnessAdapter 重构
2. Workspace UI + Feishu Sync 重构

### 我的建议

**先做 Workspace UI + Feishu Sync，再做 HarnessAdapter 重构。**

### 原因

#### 1. 这是用户体验主路径

当前最直接影响“能不能像 Codex Desktop 那样高效工作”的，不是 harness abstraction，而是：

- 项目是否统一
- Web 和 Feishu 是否同步
- 左栏是否能管理并行项目
- 是否知道哪里需要我处理

#### 2. 这是产品主模型问题，不先统一会反复返工

如果先做 HarnessAdapter，但 workspace 主模型仍不清晰，后面前端改造时还是会反复碰：

- room 到底是什么
- Feishu 绑定对象到底是什么
- 未读和 attention 挂在哪个对象上

#### 3. HarnessAdapter 重构更多是内部可维护性收益

它非常重要，但它解决的主要是：

- 后续接新 harness 更快
- 平台代码更干净
- continuation / capability / permission 更统一

这更偏“内部平台工程收益”，不是当前最急迫的产品体验收益。

### 什么时候应该反过来先做 HarnessAdapter

只有在下面场景里，才应优先 HarnessAdapter：

- 你们马上要接很多新 harness
- 当前 harness 侧 bug 已经严重影响主业务
- runner / continuation 逻辑已经碎到阻碍所有后续开发

从现在的情况看，这三个条件都没有“Workspace 主模型不清晰”更急。

## 推荐执行顺序

### Phase 1：先统一 Workspace 主模型

目标：

- 明确 canonical workspace
- 定义 workspace 与 task/live room/Feishu binding 的关系

### Phase 2：补同步链路

目标：

- Feishu side 和 Web side 共享同一个 workspace 视图

### Phase 3：做左栏 + 中栏 + 右栏结构

目标：

- 页面从控制台式过渡到工作台式

### Phase 4：做 attention / unread / waiting_for_you

目标：

- 支持真正的并行项目工作

### Phase 5：再回头做 HarnessAdapter 第一阶段重构

目标：

- 在主产品模型稳定后，收敛执行层代码

## 第一阶段建议新增/调整的产物

如果要开始做这个方向，建议先产出：

1. `Workspace` 领域模型草案
2. Web / Feishu / live room / task 的对象映射表
3. 左栏状态字段定义
4. attention 状态机
5. 同步事件流图

然后才开始写前端页面。

## 最后结论

如果你们接下来只优先做一个大方向，建议先做：

**Workspace UI + Feishu Sync**

因为这件事决定的是：

- 产品主抽象是否统一
- Web 是否能成为真正的“并行项目工作台”
- Feishu 和 Web 是否属于同一个系统，而不是两个松散拼接的入口

HarnessAdapter 重构应该做，但更适合作为下一阶段的平台内核收敛工作。
