# 31 ACPX Live Room Broadcast、`@all` 与 Member 可见性方案交接

## 日期
2026-03-25

## 背景
在 `30_ACPX_LIVE_ROOM_MENTION_AND_AGENT_TO_AGENT_HANDOVER.md` 这一轮完成后，
Live Room 已经具备：
- 结构化 mention metadata
- mention 优先于 dropdown 的 target-aware routing
- agent-to-agent 基础直聊
- handoff 的初步统一语义

但新的真实使用又暴露出三个紧接着会遇到的问题：
1. 用户如何“对整个房间说话”，而不是只点某一个 agent
2. `@all` 与普通公开发言是不是同一种语义
3. 房间里那些还没说过话的 agent，是否应该在一开始就被所有人看见

这三个问题不能混为一谈，
因为它们分别涉及：
- delivery 规则
- reply obligation
- room awareness / presence

## 当前观察到的真实问题

### 1. dropdown 现在没有“整个房间”选项
当前 dropdown 仍然只有：
- 某个具体 agent
- 或留空，回退给当前 speaker

这导致用户如果想说的是：
- “大家都看一下这个问题”
- “谁有意见都可以回”
- “全体成员先同步状态”

在产品上没有一个清晰入口。

### 2. “普通公开发言”与 `@all` 不是同一回事
这点非常关键。

在真实群聊里：
- 不带 `@all` 的公开消息
  通常表示：
  - 这是发给整个房间看的
  - 但谁回复、是否回复，可以由各成员自行判断

- 带 `@all` 的消息
  通常表示：
  - 这是一个明确的全员召集或全员通知
  - 每个成员都至少应该有“看见并决定是否回执”的义务
  - 在多 agent 场景下，往往意味着系统级 fan-out，而不是只给一个默认 speaker

所以：
- `broadcast`
  不等于
- `mention all`

### 3. 现在“没发过言的 agent”对其他 agent 不够可见
当前如果一个 agent 加入了 room，但还没有发过消息，
其他 agent 对它的感知主要依赖：
- room transcript 中是否已经出现过它
- prompt 中有没有顺带列出 room 成员

这会导致一个非常真实的问题：
- room 明明已有 7 个成员
- 但如果只有 3 个发过言
- 其他 4 个在 conversation reality 里几乎像“不存在”

这不利于：
- agent 做合理 delegation
- agent 知道房间里有哪些可用 specialist
- 新加入成员被自然纳入协作

## 推荐的产品语义分层

### 模型 A. 普通公开发言 `broadcast`
建议新增一种明确语义：
- `deliveryIntent = broadcast`

它表示：
- 这条消息面向整个房间可见
- 不强制每个成员都必须回复
- 系统只需要挑选“一个或少量最可能应该回应的 agent”

它适合：
- 用户面向整个房间抛问题
- 用户分享上下文或状态更新
- agent 自己发公开同步，不想点名任何单一对象

### 模型 B. `@all`
建议把 `@all` 视为另一层更强的语义，而不是普通 broadcast 的别名。

建议语义：
- `deliveryIntent = mention_all`

它表示：
- 这条消息对所有当前 joined 成员都构成明确点名
- 系统应把 room 中所有可 reply 成员加入本次 fan-out 目标集
- 每个成员都应至少获得一次 reply 机会或 delivery record

它适合：
- 用户要求全员回执
- 房间启动时的“所有成员先报到”
- 全员同步某一轮状态

### 模型 C. `ask_many`
如果后续还想更细分，
可以再引入：
- `deliveryIntent = ask_many`

含义：
- 面向一个小集合提问，而不是单人或全体
- 例如 `@researcher @main @claude`

这一层不是现在必须做，
但从协议设计上值得预留。

## 推荐的统一消息 metadata 扩展

在现有字段基础上，建议追加：
- `mentionedAll: boolean`
- `broadcastScope: room | selected_members`
- `expectedResponderMemberIds: string[]`
- `requiredResponseMode: none | any_one | all`
- `deliveryIntent: broadcast | user_target | mention | ask | handoff | mention_all`

推荐语义：
- `broadcast`
  公开可见，但不强制全员回
- `mention_all`
  全员应收到明确投递
- `requiredResponseMode = any_one`
  只需要有一个合适 agent 接话
- `requiredResponseMode = all`
  需要全体成员都给出回应或至少回执

## dropdown 与 `@all` 的关系

### 不建议把 dropdown 的 “All members” 做成唯一入口
原因是：
- dropdown 更适合“这条消息优先给谁”
- 它天然是单 target 心智
- 如果硬在 dropdown 里加一个 `All members`，会让单 target 与 fan-out 混在一起

### 更推荐的做法
建议保留 dropdown 作为：
- 单一主目标选择器

再新增一层更接近群聊心智的机制：
- 文本里输入 `@all`
- 或 composer 上有一个显式的 `Broadcast to room` / `Notify all` 轻量开关

我更推荐优先做：
- `@all`

原因：
- 更符合真实聊天习惯
- 与现有 mention 体系一致
- 后续也更容易让 agent 自己输出 `@all`

## “不带 `@all` 的公开消息”应该怎么处理

### 推荐默认行为
如果用户没有点 dropdown，
也没有 mention 某个具体 member，
那这条消息应被视为：
- `broadcast`

但这个 broadcast 不应自动 fan-out 给所有 agent 同时回答。

推荐调度方式：
1. 先写入 room message
2. 所有成员都可见
3. delivery 层根据策略选一个 primary responder
4. 其他成员只是在上下文上“看见了”，不强制立刻回复

### primary responder 怎么选
短期建议：
1. current speaker
2. 最近发言最相关的 member
3. fallback default responder

长期建议可以演进到：
- 能力匹配
- topic 匹配
- 最近是否刚回复过
- 是否 busy

## `@all` 应如何调度

### 推荐不是“全员同时立刻开说”
虽然 `@all` 表示每个人都该收到，
但如果系统直接让 7 个 agent 同时抢答，
会很快造成：
- 消息爆炸
- 上下文噪音
- 房间失控

### 推荐的更稳妥策略
1. `@all` 写入 room message
2. 系统解析出当前所有 `canReply = true` 的 joined members
3. 为每个 member 写 delivery record
4. 回复模式由配置决定：
   - `all_required_ack`
   - `all_optional_reply`
   - `staggered_reply`

### 初期最推荐的模式
建议第一版做：
- `@all` -> staggered reply

也就是：
- 所有人都收到
- 但按顺序或小批次回复
- 避免同时七个 agent 一起刷屏

例如：
- 当前 speaker 先答
- 其余成员在短时间窗口内按队列补充
- 或只要求每人一句短状态

## 关于“房间刚创建时，成员是否应彼此可见”

### 建议答案：应该
我不建议继续保持“只有发过言的人才真正存在于 transcript reality 中”。

原因：
- 这会让 delegation 很弱
- agent 不知道还有哪些 specialist 在场
- 用户也不容易理解 room 当前到底有哪些能力

### 推荐方案 A. room 创建时自动发系统 roster 消息
在房间创建或新成员加入时，
自动插入一条 system message，例如：
- 当前房间成员：
  - main / Linux Gateway / main
  - researcher / Windows Gateway / researcher
  - Platform Local Codex / codex

优点：
- 审计清晰
- transcript 内可见
- agent 能从历史直接读到

缺点：
- 成员频繁变动时，system 噪音会增多

### 推荐方案 B. 在 agent prompt 中始终注入当前 room roster
无论谁最近有没有发言，
在发给 agent 的 room prompt 里都附加：
- current members
- each member label
- gateway / harness
- role / canReply

优点：
- agent awareness 更稳定
- 不依赖 transcript 恰好提到过谁

缺点：
- 如果只做 prompt 注入，不做 room message，用户侧审计不够直观

### 推荐方案 C. 两者都做，但各司其职
这是我最推荐的方案。

具体做法：
- 房间创建时写一条 roster system message
- 成员加入/移除时写 delta system message
- agent prompt 始终注入当前 member roster

这样可以同时得到：
- transcript audit
- agent awareness
- 用户可见性

## 推荐的下一轮开发顺序

### Phase 1. 先补 room roster awareness
目标：
- 没发过言的成员也能被所有人感知

交付物：
- room 创建时写 roster system message
- member add 时写 delta system message
- buildPrompt 时始终注入 current members 列表

### Phase 2. 引入 `broadcast`
目标：
- 不点任何具体对象时，消息真正面向整个房间

交付物：
- `deliveryIntent = broadcast`
- dropdown 留空时不再等同于“current speaker 私聊”
- delivery 层仍然只挑一个 primary responder

### Phase 3. 引入 `@all`
目标：
- 让用户和 agent 都能发起全员通知

交付物：
- composer 识别 `@all`
- metadata 落 `mentionedAll = true`
- delivery fan-out 到所有 joined 且可回复成员
- 用 staggered reply 避免刷屏

### Phase 4. 再决定是否要 `ask_many`
如果后续出现大量：
- `@researcher @main @claude`
这种半定向群组提问，
再进一步引入 selected-members fan-out 语义。

## 我的明确建议

### 建议 1
不要把“没有 mention 的消息”理解成“只有 current speaker 能看见”。
更合理的是：
- everyone can see
- one member is selected to answer first

### 建议 2
把 `@all` 视为强语义，不要和普通公开发言混用。

### 建议 3
不要只靠 transcript 自然发言来让成员彼此认识。
房间创建时就应该让：
- 用户知道成员 roster
- agent 也知道完整 roster

### 建议 4
第一版不要让 `@all` 触发全员同时自由长回复。
先做：
- 全员收到
- 顺序或短回复

这样系统会稳定得多。

## 给下一位会话的结论

下一步最值得做的不是继续抠单一 mention 细节，
而是把 room communication 再往上抬一层，补上：
- broadcast
- `@all`
- room roster visibility

一句话总结：
`@member` 解决的是定向路由，
`broadcast` 解决的是公开发言，
`@all` 解决的是全员召集，
而 room roster visibility 解决的是“大家一开始是否真正知道彼此在场”。

## 当前实现状态补记

截至本轮，第一版已经开始落地：
- 不点 dropdown、也不点名具体 member 的消息，会按 `broadcast` 语义处理
- composer 里已支持 `@all`
- `@all` 会 fan-out 给当前房间内所有可 reply 成员，并按顺序回复
- room 创建时会自动写 roster system message
- member 加入时会再次写入最新 roster
- agent prompt 中会始终注入 current room members
- `@all` 发出后会先插入一条 dispatch system message，提示本轮共有多少成员已进入顺序回复队列
- `@all` 回复之间会加入一个轻量 stagger 间隔，避免多 agent 同时刷屏
- composer 已明确展示当前发送模式：`broadcast / direct / mention / @all`
- 消息气泡里会显示 `@all` 与 queued count，方便观察当前 fan-out 规模

## 本轮调试补记：为什么曾出现“@all 只有 Codex 在回复”

### 现象
真实测试里出现过：
- 用户发出 `@all`
- system message 也显示 `queued: 8`
- 但真正连续回复的只有 `Platform Local Codex`

### 根因
问题不在于 fan-out 队列没有生成，
而在于执行每一轮 agent reply 时，
delivery 仍然优先尊重 source message 上的：
- `primaryTargetMemberId`

而那条 `@all` 消息里，
`primaryTargetMemberId` 恰好落在了 `Platform Local Codex`。

结果就是：
1. `@all` 队列的确生成了 8 个 target
2. 但每次进入单个 reply 执行函数时
3. 系统又重新按 `primaryTargetMemberId` 选目标
4. 最终 8 次都重复命中 Codex

所以这不是“只有 Codex 收到了消息”，
而是：
- `fan-out queue` 是对的
- `per-target execution` 被 `primaryTarget` 抢回去了

### 修复方式
本轮已改成：
- 普通 `mention / broadcast` 仍走原有优先级
- 但 `@all` fan-out 进入逐个执行阶段时，
  每一轮都强制按当前队列 target 执行
  不再让 `primaryTargetMemberId` 抢走该轮目标

也就是说：
- `@all` 的“队列 target”在执行期优先级更高
- 这才是真正的全员 fan-out

## 关于底部 UI 文案的判断

### 你的观察是对的：它会造成误读
在出问题那一版里，底部同时显示：
- `向整个房间说话（由当前 speaker 优先回应）`
- `这是一条面向整个房间的公开消息，当前 speaker 会优先回复`
- `mode: broadcast`

这套文案在 `@all` 场景下会让人自然怀疑：
- 系统是不是其实还是只先投给 current speaker
- 所以才导致只有 Codex 在回复

### 更准确的判断
严格说，真正的 bug 不是这句文案直接造成的，
而是执行层的 target precedence 问题。

但这句文案确实暴露了一个产品心智问题：
- `broadcast`
  和
- `@all`
  不应该共享同一套弱提示

因为：
- `broadcast` 是“整个房间都能看见，但只有一个主回复者先接话”
- `@all` 是“所有可回复成员都进入本轮回复队列”

所以在 handover 上应明确记住：
- 如果 UI 仍然强调“current speaker 优先回应”
- 用户会非常容易误会 `@all` 其实只是特殊文案，不是真 fan-out

### 后续 UI 建议
在 `@all` 状态下，应尽量显式显示：
- `当前模式：@all`
- `本轮 queued responders: N`
- `responses will be staggered`

而不是继续沿用：
- `当前 speaker 会优先回复`

因为那是 `broadcast` 心智，不是 `@all` 心智。

当前仍建议后续继续完善：
- `@all` 的节流与更细的 stagger 策略
- `broadcast` 的 primary responder 选择策略
- roster system message 的噪音控制
