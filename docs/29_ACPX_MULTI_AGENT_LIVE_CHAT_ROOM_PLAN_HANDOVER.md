# 29 ACPX 多 Agent 实时聊天室方案交接

## 日期
2026-03-25

## 背景与目标
当前 `/tasks/[id]/chat` 已经具备明显的 chat-first 外观，但底层仍然是典型的 `task run` 页面：
- 用户输入先进入 `task room`
- `active run` 决定谁在真正执行
- `participant target` 只是 message metadata
- 非 active participant 不会在任务进行中实时收到新消息
- gateway participant 目前也不是“持续在线 agent”，而是被 runner 在轮到时调用一次

用户这次要的不是继续修当前 task room 的文案，而是新增一个真正的“多 Agent 实时聊天室”页面，满足：
- 页面形态尽量接近 ChatGPT 界面
- 可以从任意 gateway 选择任意可用 agent 加入房间
- 用户可以像在群聊里一样持续发言
- agent 在任务进行中也能继续被打断、追问、澄清、补充上下文
- 可以在房间里设定一个 topic / task，并围绕它持续互动
- 不再是“派发一次任务，然后等它完成”的单轮 dispatch 模型

一句话说：
要做的是 `Live Agent Room`，不是继续把 `Task Run Room` 修得更像聊天。

## 本轮代码审查后的核心判断

### 1. 当前 `/tasks/[id]/chat` 的产品中心仍然是 run，不是 room
关键文件：
- `src/app/tasks/[id]/chat/page.tsx`
- `src/app/api/tasks/[id]/control/route.ts`
- `src/app/api/tasks/[id]/execute/route.ts`
- `src/lib/acpx/runner.ts`
- `src/lib/task-room.ts`

当前页面虽然有：
- 聊天模式 / 执行模式
- participant target
- 对话时间线
- continuation
- 权限设置

但页面的一切主逻辑还是围绕这些状态：
- `activeRunSummary`
- `selectedRun`
- `controlRunId`
- `canContinueSelectedSession`
- `interrupt_now / stop_run / continue_session`

这说明它本质上还是：
- 先有 run
- 再围绕 run 补聊天能力

而不是：
- 先有 live room
- run 只是 room 内的一种动作

### 2. `participant target` 目前只是“写入 transcript 时打标”
`src/app/api/tasks/[id]/control/route.ts` 当前行为非常清楚：
- 先 `postTaskRoomMessage`
- 再根据 action 决定：
  - `queue_message`
  - `continue_session`
  - `interrupt_now`
  - `stop_run`

其中：
- `queue_message` 只会写 room，然后返回 `deliveryResult = queued`
- `continue_session` 只支持 `platform_local + codex + 已有 continuationThreadId`
- `interrupt_now / stop_run` 也只会尝试对当前本地运行进程发控制信号

所以现在并不存在：
- “把消息直接送给某个 gateway participant 的 live inbox”
- “给非 active participant 追加一条正在进行中的对话输入”

### 3. runner 仍然是 staged orchestration，不是并发在线会话
`src/lib/acpx/runner.ts` 的核心流程是：
1. 创建一个 `TaskRun`
2. 顺序遍历 participants
3. 每个 participant 启动一次执行
4. participant 完成后记录 summary
5. 下一个 participant 读取 task room transcript 继续

这有两个关键含义：
- participant 是“阶段节点”，不是“长期在线成员”
- transcript 是“运行时上下文”，不是“会话内实时消息总线”

也就是说，当前 ACPX runner 的抽象非常适合：
- staged handoff
- reviewer / implementer 串行协作

但不适合：
- 3 个 agent 和用户在同一房间里长期讨论
- 用户在执行期间随时追问某个远端 agent
- 多 agent 在同一话题下轮流或并行发言

### 4. gateway 侧已经有 sessionKey 雏形，但还只是 request-response
`src/lib/openclaw-client.ts` 和 `src/app/api/gateways/chat/route.ts` 说明：
- 平台已经支持用 `sessionKey` 请求 OpenClaw `/v1/responses`
- 也已经有一个简单的 cross-gateway chat session 持久化模型

但现在这个模型还是：
- 一次请求，拿一次完整回复
- 没有统一的 live room membership
- 没有 agent presence / typing / online state
- 没有多 agent 房间级消息模型
- 没有用户消息到房间成员的广播与投递确认

因此它可以作为“新页面的协议基础”，但不能直接当最终产品模型用。

### 5. Prisma 数据模型目前缺少“实时聊天室”核心实体
当前 schema 里相关实体主要是：
- `ChatRoom`
- `Message`
- `TaskRun / TaskRunParticipant / TaskRunEvent`
- `CrossGatewayChatSession / CrossGatewayChatMessage`

缺少的新实体包括：
- live room
- live room member
- member session
- delivery receipt
- topic / thread
- room-level agent turn policy

换句话说，数据库已经有：
- task transcript
- run audit
- 双 gateway demo transcript

但还没有：
- 多 agent 实时会话的稳定领域模型

## 产品方向建议

### 不建议继续在 `/tasks/[id]/chat` 上硬改
原因不是页面样式不行，而是领域模型不对。

如果继续在任务页上叠加：
- agent 邀请
- live messaging
- topic
- room membership
- online agent presence
- 并行 agent reply

最后会把一个 run page 变成：
- 一半是 task orchestration console
- 一半是 live chat product

这会让：
- 状态更混乱
- 数据结构更别扭
- UI 语义越来越不诚实

### 推荐新增独立页面：`/rooms/[id]` 或 `/live-chat/[id]`
建议新增独立产品面：
- 左侧：会话列表 / 新建房间
- 中间：主对话区
- 顶部：当前模型/房间名/成员管理
- 底部：ChatGPT 风格 composer
- 右侧：可折叠房间信息、topic、参与成员、运行状态

这页的主语义应该是：
- “房间中的持续会话”

而不是：
- “某个 task 的当前 run 详情”

### ChatGPT 风格应复刻的是交互模型，不只是皮肤
用户提到“looks exactly the same as ChatGPT interface”，建议理解为优先对齐以下交互心智：
- 左侧是会话列表，而不是 task list
- 中间只有单一主线程，阅读负担低
- 用户消息和 assistant 消息样式稳定
- 系统事件不抢占主消息流
- composer 永远是主入口
- topic / model / participants 是轻量上下文，不是大控制台

不要把重点放在像素级仿制，而应放在：
- 使用路径像 ChatGPT
- 认知负担像 ChatGPT
- “说一句就继续聊”的响应模式像 ChatGPT

## 建议的新领域模型

### 1. Live Room
建议新增实体，例如：
- `LiveRoom`
  - `id`
  - `title`
  - `description`
  - `sourceTaskId` 可选
  - `currentTopic`
  - `mode`：`discussion | execution | hybrid`
  - `status`：`active | archived`
  - `createdBy`
  - `createdAt / updatedAt`

这个 room 不等于 task，也不等于 run。

一个 task 可以关联一个或多个 live room：
- 一个用于前期讨论
- 一个用于执行协作
- 一个用于复盘

### 2. Live Room Member
新增实体，例如：
- `LiveRoomMember`
  - `roomId`
  - `memberType`：`user | local_agent | gateway_agent | system`
  - `gatewayId`
  - `agentId`
  - `agentNameSnapshot`
  - `harnessType`
  - `roleLabel`
  - `joinStatus`
  - `presenceStatus`
  - `canReply`
  - `sortOrder`

关键点：
- 房间成员是 first-class object
- 不再依附于某一次 run participant

### 3. Live Room Message
建议单独建表，不复用现在的 `Message`

理由：
- 当前 `Message` 过于 task-room 导向
- 缺少 room member / delivery / message kind / reply threading 等字段

建议新增：
- `LiveRoomMessage`
  - `roomId`
  - `senderMemberId`
  - `messageType`：`user | assistant | system | tool | topic | control`
  - `content`
  - `topicSnapshot`
  - `replyToMessageId`
  - `visibility`
  - `createdAt`

### 4. Member Session
这是最关键的新层。

建议新增：
- `LiveRoomMemberSession`
  - `roomId`
  - `memberId`
  - `backend`：`platform_local | gateway_openclaw`
  - `sessionKey`
  - `threadId`
  - `status`：`online | offline | busy | expired`
  - `supportsStreaming`
  - `supportsAppendMessage`
  - `supportsInterrupt`
  - `lastHeartbeatAt`
  - `lastDeliveredAt`
  - `lastError`

没有这层，就不可能真正支持：
- 任务进行中继续聊
- 同一 agent 多轮连续上下文
- gateway agent 的可寻址 live session

### 5. Delivery Audit
建议新增：
- `LiveRoomDelivery`
  - `roomMessageId`
  - `targetMemberId`
  - `sessionId`
  - `deliveryStatus`
  - `attemptedAt`
  - `acknowledgedAt`
  - `fallbackReason`

它的作用是把下面几件事区分清楚：
- 消息写入房间成功
- 消息投递给 agent session 成功
- agent 已开始回复
- agent 当前不可达，已回退为仅写入 transcript

## 推荐的交互模型

### 模型 A：Room 是主对象，Task 是可选挂件
新页面里用户先进入 room，再在 room 里做这些事：
- 邀请 agent
- 设定 topic
- 聊天讨论
- 点选“开始执行”
- 在执行过程中继续追问/补充/打断

Task 在这里应该退到第二层：
- 可以从 room 生成 task
- 可以把 room 绑定到 task
- 可以把 run 结果回写到 room

但不应该继续让 task 决定 room 的主心智。

### 模型 B：消息永远先入房间，再异步投递成员 session
推荐统一流程：
1. 用户消息写入 `LiveRoomMessage`
2. 基于当前 room policy 选择投递目标
3. 对每个可达 member session 发投递
4. agent 回复也回写到 `LiveRoomMessage`
5. UI 只消费房间消息流，不直接消费 run event 作为主视图

这样做的好处：
- 审计不会丢
- 页面是单一消息流
- UI 语义稳定
- 后续可以接多个 backend

### 模型 C：Run 变成 room 内的一种“执行状态”，不是整页骨架
也就是说：
- 可以在 room 里启动 run
- run 也会写系统消息和执行消息到 room
- 但主界面仍然是 room transcript

而不是像现在这样：
- 页面主体来自 run + control + task-room 混合态

## 推荐的实施阶段

## Phase 0. 先做“新页 + 新模型”，不要先改旧 task room
目标：
- 先把新页面的骨架独立出来
- 先把 Live Room 相关 Prisma 模型建出来
- 先让新页面读取独立数据

建议：
- 新增路由 `/rooms`、`/rooms/[id]`
- 保留旧 `/tasks/[id]/chat`
- 两条产品线短期并存

这样风险最小，因为：
- 老 task orchestration 不中断
- 新 live chat 可以独立迭代

## Phase 1. 先打通“房间 + 成员 + 单 agent 续聊”
第一阶段不要一开始就上多 agent 并发。

先做最小闭环：
- 用户创建 room
- 从平台可见 agent 列表选择成员
- 房间支持 topic
- 先只允许一个“当前主回复 agent”
- 用户发送消息后，优先投递给该 agent 的 session
- agent 回复实时写回 room

优先顺序建议：
1. 本地 `platform_local/codex`
2. 本地 `platform_local/claude`
3. 单个 gateway agent

只要这个闭环成立，页面就已经比当前 task room 更像 ChatGPT。

## Phase 2. 建立统一的 agent catalog 与 room member picker
当前 agent 数据分散在：
- `Agent`
- `Gateway.agents`
- `Task.acpxParticipants`

建议新增统一查询层，例如：
- `src/lib/live-room/agent-catalog.ts`

统一产出一个给 UI 用的 agent 目录：
- agent 唯一 key
- gateway 来源
- backend 类型
- harness 类型
- runtime agent id
- 是否可直接聊天
- 是否支持 streaming
- 是否支持 continuation
- 是否在线

前端新页面的“选择成员”必须基于这个 catalog，而不是 task participants。

## Phase 3. 打通 member session registry
建议新增：
- `src/lib/live-room/member-session-registry.ts`
- `src/lib/live-room/delivery.ts`
- `src/lib/live-room/types.ts`

至少统一这几件事：
- 如何为 member 找到当前 session
- 如何创建新 session
- 如何向 session append message
- 如何标记 session 过期
- 如何记录 delivery result

本阶段的真正门槛在 gateway：
- OpenClaw 是否允许同一 `user/sessionKey` 稳定续聊
- 是否支持流式返回
- 是否支持中断或至少取消中的请求

如果 OpenClaw 当前只有“带同一 sessionKey 的新请求”，那第一版也能做：
- 伪 live continuation
- 每次新消息触发一次新的 responses.create

这还不算完美，但已经足够支撑“持续对话”的首版产品。

## Phase 4. 引入 room topic 与执行模式切换
用户明确提到：
- “we can then set a topic like a task and we do those task interactively”

建议不要把 topic 只是做成一条普通消息，而是 room 级字段：
- `currentTopic`
- `topicUpdatedAt`
- `topicUpdatedBy`

UI 里放在顶部轻量展示：
- 当前 topic
- 编辑 topic
- 将 topic 转成执行目标

建议同时保留 room mode：
- `discussion`
- `execution`
- `hybrid`

含义：
- `discussion`：只聊天，不自动触发 agent 执行
- `execution`：用户消息默认路由到主 agent 执行
- `hybrid`：聊天与执行都允许

## Phase 5. 再做多 agent 轮值 / 并发回复
这阶段才处理真正复杂的问题：
- 多 agent 同时收到同一条消息，谁先回
- 是否允许多个 agent 并发 streaming
- 是否需要主持人 / moderator policy
- agent 是否可以互相引用前文

推荐先做“轮值”而不是“完全并发”：
- room 内可以有多个 agent
- 但同一时刻只允许一个 `active speaker`
- 用户可手动切换“由谁来答”
- 也可以提供 `@agent` 点名

这是复杂度和可用性最平衡的做法。

## Phase 6. 最后才把 run 能力优雅接入 room
这一阶段把 ACPX 的执行能力变成 room 的一个子系统：
- 用户在 room 里点击“开始执行”
- 生成一个 execution thread / run
- run 的关键事件写回 room
- room 可继续发消息影响后续步骤

这时旧的 `TaskRunEvent` 可以继续保留做审计和调试，
但主 UI 不应再直接消费它作为主消息流。

## 前端页面建议

### 页面结构
推荐新增：
- `src/app/rooms/page.tsx`
- `src/app/rooms/[id]/page.tsx`
- `src/components/live-room/...`

### `/rooms` 列表页
功能：
- 会话列表
- 新建 room
- 最近 topic
- 最近成员
- 最近活动时间

这个页面应尽量贴近 ChatGPT 左栏体验：
- 简洁
- 会话优先
- 不塞监控信息

### `/rooms/[id]` 主页面
建议布局：
- 左侧：room list / new room
- 中间：消息主流 + 顶部标题 + 底部 composer
- 右侧：可折叠 room details

顶部信息只保留：
- room title
- 当前 topic
- 成员头像/标签
- 模式
- 轻量设置入口

不要继续保留当前 task room 那种高密度 pills + run 状态堆叠在顶部。

### 消息流建议
消息分层显示：
- 用户消息
- agent 回复
- 轻量系统消息

执行事件不要默认占满主流，只在必要时折叠显示：
- agent 开始处理
- agent 需要权限
- agent 执行完成

如果直接把 `control_message / participant_completed / run_completed` 原样暴露出来，
页面还是会像控制台，不像 ChatGPT。

### Composer 建议
底部 composer 需要成为唯一强入口：
- 大输入框
- `@agent` 或成员选择
- topic 快捷入口
- 附加动作折叠到左下或右下

不要像当前 task room 一样在 composer 上方长期堆：
- 模式切换
- target selector
- 权限按钮
- 多条 notice

这些应收敛进轻量工具栏或右侧面板。

## 后端 API 建议

### 建议新增 API
- `GET /api/live-rooms`
- `POST /api/live-rooms`
- `GET /api/live-rooms/[id]`
- `GET /api/live-rooms/[id]/messages`
- `POST /api/live-rooms/[id]/messages`
- `POST /api/live-rooms/[id]/members`
- `DELETE /api/live-rooms/[id]/members/[memberId]`
- `POST /api/live-rooms/[id]/topic`
- `POST /api/live-rooms/[id]/deliver`
- `POST /api/live-rooms/[id]/runs`

### 建议不要直接复用现有 task control API
`/api/tasks/[id]/control` 当前设计天然绑定：
- task
- run
- control message
- continuation

它不适合直接承接：
- room member messaging
- live delivery
- member presence

最好的做法是：
- 新 room API 独立
- 必要时在内部调用现有 ACPX runner

## 与现有代码的复用建议

### 可以复用
- `src/lib/openclaw-client.ts`
- `src/lib/task-room-targets.ts` 里的 participant key 生成思路
- `src/lib/acpx/permissions.ts`
- websocket 基础设施
- 本地 codex thread 续聊能力
- gateway `sessionKey` 传递方式

### 不建议直接复用为主模型
- `TaskRunParticipant` 作为 room member
- `TaskRunEvent` 作为 room message
- `Message` 作为 live room 全部消息模型
- `/api/tasks/[id]/control` 作为新页面的主消息 API

这些都太偏旧模型，会把新页面拖回 run-first。

## 关键风险

### 1. gateway session 能力可能不够“真 live”
这是最大风险。

要尽快验证：
- 同一 sessionKey 是否真的保留上下文
- 多轮请求的延续质量如何
- 是否有 streaming 接口
- 是否支持取消/中断

如果这些能力不足，第一版仍然能做，但要诚实表达为：
- 持续会话
- 近实时追加

而不是承诺完全实时双工会话。

### 2. 多 agent 同时在线会把状态复杂度放大很多
如果一开始就做：
- 任意 agent 同时回复
- 执行和对话并发
- 多人同时 typing

会立刻带来：
- 乱序
- UI 抢焦点
- 用户不知道现在该看谁

所以第一版强烈建议：
- 多成员
- 单 active speaker
- 用户可切换 speaker

### 3. 旧 task room 和新 live room 的边界必须讲清楚
否则团队很容易继续把需求加到旧页上。

建议明确定位：
- `/tasks/[id]/chat`：run orchestration / execution audit
- `/rooms/[id]`：interactive live collaboration

## 推荐的实际开发顺序

1. 先补 Prisma schema，建立 `LiveRoom`、`LiveRoomMember`、`LiveRoomMessage`、`LiveRoomMemberSession`、`LiveRoomDelivery`
2. 做 agent catalog 聚合层，统一列出可加入房间的 agent
3. 做 `/rooms` 与 `/rooms/[id]` 的页面骨架，先把 ChatGPT 风格结构立住
4. 做 room message API 和 websocket push
5. 先接本地 Codex 单 agent continuation，验证“持续聊天页”闭环
6. 再接单个 gateway agent continuation
7. 再加 room topic、speaker 切换、成员管理
8. 最后把 ACPX run 作为 room 内动作接进来

## 给下一位开发会话的明确结论

### 这次不要再做的事
- 不要继续把 `/tasks/[id]/chat` 当成最终形态
- 不要继续只修 participant target 文案
- 不要把 live chat 继续建在 `TaskRunEvent` 之上

### 这次应该直接开始做的事
- 新建独立 live room 数据模型
- 新建独立 `/rooms/[id]` 页面
- 先用 ChatGPT 式布局实现单线程主消息流
- 先打通“用户 <-> 单 agent 持续会话”

## 一句话总括
当前代码库已经具备做“多 gateway agent 持续对话”的若干底层积木，
但现有 task room 的核心抽象仍然是 `run orchestration`，不是 `live collaboration room`。

所以最稳妥、也最符合用户目标的路线不是继续修旧页，
而是：

新建一套 `Live Room` 产品面和数据模型，
让 ChatGPT 风格 UI 真正对应到“可持续对话、可持续投递、可持续续聊”的后端能力上。
