# 28 ACPX Cross Gateway Realtime Direct Delivery Handover

## 日期
2026-03-24

## 背景
在 `27_ACPX_CROSS_GATEWAY_REVIEWER_CANNOT_HEAR_ME_HANDOVER.md` 之后，
当前系统已经进一步确认：
- task room 里的 participant target 目前只是 message metadata
- active run 执行期间，发给非 active participant 的消息不会实时直达
- runner 仍然是在启动 participant 时统一读取 task room transcript

这意味着：
- UI 看起来像“给 reviewer 发消息”
- 真实行为却还是“留言，等后续 run 读取”

本轮已经先做了两件止血工作：
- UI 文案改得更诚实，不再暗示 participant target 是实时直达
- composer 区域进一步压缩，减小底部工具区高度，同时去掉右侧重复的 Inspector 小按钮

但用户现在明确要求往“进取路线”走：
- 不只是把语义说清楚
- 而是真正支持非 active participant，尤其是跨 gateway reviewer，实时收到用户消息

## 本轮已落地的界面调整

### 1. composer 更紧凑
当前已把底部 composer 区域收窄：
- 聊天模式 / 执行模式按钮字体更小
- target selector 与权限快捷按钮更小
- target 提示条从一整排大号 pill 改成更紧凑的说明条
- 输入框和底部动作按钮整体高度下降

目标是让底部区域更像轻量控制条，
而不是第二个大面板。

### 2. 去掉重复 Inspector 入口
当前页面顶部已经有：
- `显示侧栏 / 隐藏侧栏`

所以右侧收起态那颗额外的：
- `Inspector`

已经没有必要。

当前已调整为：
- 侧栏关闭时不再保留右侧窄栏
- 也不再显示重复的 Inspector 浮动按钮

这能减少视觉噪音，也能给主聊天区更多宽度。

## 当前真实问题重新定义

现在的问题不应该再叫：
- reviewer 听不到我

而应该准确表述为：
- ACPX 还没有 participant-level realtime inbox / live routing
- 用户消息只能进入 room
- orchestration 没有把非 active participant 当作独立在线会话对待

所以要真正支持跨 gateway reviewer 立刻听到用户，
必须补的是一整层新能力，而不是继续 patch 文案。

## 目标能力

需要新增的不是“更聪明地读 task room”，
而是：

### 1. participant-level 实时送达
用户把消息 target 到某个 participant 时：
- 平台应尝试把它直接送到该 participant 的 live session
- 不应默认等到后续 run / handoff

### 2. 非 active participant 也能拥有 live session
当前 active run 的 active participant 之外，
如果另一个 participant 已有可通信 session，
平台也应允许：
- 继续向它发消息
- 接收它的增量回复

### 3. 跨 gateway reviewer 独立在线
对 gateway participant，
平台需要把“room participant”升级成：
- 可连接
- 可寻址
- 可投递
- 可回传状态

否则 reviewer 永远只是 staged orchestration 中“以后会轮到它”的一个节点。

## 建议的产品模型

### 模型 A. Task Room 继续保留
task room 仍然负责：
- 持久化聊天记录
- 给后续 run 提供共享上下文
- 保留系统消息 / 控制消息 / 审计轨迹

### 模型 B. 新增 Participant Inbox / Live Session
每个 participant 额外拥有一层 live 通道语义：
- 是否在线
- 当前 sessionKey
- 是否可实时接收用户输入
- 是否正在回复
- 最近一次投递结果

### 模型 C. target participant 时优先“直达”，失败再 fallback
新的默认行为应是：
1. 先写入 task room，保留审计
2. 再尝试直达 participant live session
3. 若 participant 当前不可达，再明确标记 fallback to queue

这样：
- 审计不会丢
- 用户也能分清“已直达”还是“仅排队”

## 推荐实施阶段

### Phase 0. 先抽出 participant live delivery 抽象
先不要把直达逻辑散落在 `control route` 里临时拼。

需要新增统一抽象，例如：
- `participant-session-registry.ts`
- `participant-delivery.ts`
- `participant-session-types.ts`

至少要表达：
- participant target key
- current session key / thread key
- backend kind
- live capability
- delivery result
- fallback reason

建议优先关注：
- `src/app/api/tasks/[id]/control/route.ts`
- `src/lib/acpx/runner.ts`
- `src/lib/acpx/process-registry.ts`
- `src/lib/openclaw-client.ts`

### Phase 1. 先打通本地 participant 直达能力
先在 platform local 上建立可工作的 participant inbox 概念。

目标：
- active local Codex 仍可继续现有 continuation 模式
- 非 active 但已有 local live session 的 participant 也能被直接投递

如果本地都做不稳，
跨 gateway 会更难收敛。

### Phase 2. 为 gateway participant 建立 session registry
关键点不是 room message，而是 gateway session 寻址。

至少需要能追踪：
- 某个 gateway participant 当前是否有可复用 session
- sessionKey 是什么
- 最近一次心跳时间
- 是否允许 `responses.create` / `resume` / `message append`

这一步需要研究 `OpenClaw` 当前是否已经支持：
- 持久 session key
- 同一 agent 的多轮追加输入
- 服务端推送 / polling 的 session continuation

如果 OpenClaw 目前只支持“单次请求-单次响应”，
那么就要先补 gateway 侧协议，
否则“实时直达”最多只是快速新建临时 run，而不是真 live session。

### Phase 3. 在 control route 中引入“先投递、再回退”
`/api/tasks/[id]/control` 需要新增 participant-level delivery 分支。

建议行为：
- `queue_message`
  - 仍先写 room
  - 再尝试 `deliverToParticipantSession`
  - 返回：
    - `delivered_to_participant_session`
    - `fallback_to_queue`
- `interrupt_now`
  - 仍只控制 active run
  - 不要把它和“给 reviewer 发实时消息”混为一谈
- `continue_session`
  - 继续保留给支持 continuation 的 local Codex
  - 不要强行复用到 gateway reviewer，除非 gateway session 语义已补齐

### Phase 4. 让 UI 真正表达 live delivery 状态
当前 UI 还只有：
- queued
- continuation
- control signal

后续要新增：
- `已实时送达 reviewer`
- `reviewer 在线，正在回复`
- `reviewer 当前不可达，已回退为排队消息`
- `gateway 已连接，但该 participant 当前无 live session`

建议在 composer notice、control message、participant card 都显示一致语义。

### Phase 5. 再决定是否允许并行 participant 活跃
这是一个大的产品决策点。

如果 reviewer 可以实时在线，
那就要决定：
- implementer streaming 时 reviewer 是否也可同时 streaming
- UI 是否允许多 participant 并发回复
- selected run / active run / live participant 三者关系如何展示

建议先做：
- 单一 active run
- 多 participant live delivery
- 但同一时刻只允许一个 participant 进入“streaming reply”

先别一步跳到全并发多 agent chat。

## 需要新增的数据与状态

### 1. participant session tracking
现在 `controlMetadata` 里已有一些 thread/session tracking，
但它更偏 run 级 continuation。

后续需要扩展为 participant live delivery tracking，例如：
- `liveSessionKey`
- `liveSessionBackend`
- `liveSessionStatus`
- `lastHeartbeatAt`
- `lastDeliveryAt`
- `lastDeliveryResult`

### 2. delivery audit
仅靠 room message 不够。

建议把每次直达尝试单独记录：
- target participant
- requested at
- attempted at
- delivery result
- fallback reason
- source roomMessageId

否则后面很难排查：
- 是 target 找不到
- session 已过期
- gateway 连通但 participant 不在线
- 还是 gateway API 本身不支持追加输入

## 风险点

### 1. OpenClaw / Gateway 会话能力可能不足
这是最大风险。

如果远端 gateway 现在没有真正的可续接会话接口，
那“直达 reviewer”只能退化成：
- 平台看到消息后
- 立刻帮你拉起 reviewer 的一个新 run

这不等价于 live chat。

### 2. 多 participant 同时在线会冲击当前 activeRun 模型
当前页面模型还是：
- 一个 active run
- 该 run 中 staged participants 依次执行

一旦 participant 变成可实时寻址，
就会逼着系统重新定义：
- 谁算 active
- 谁可被控制
- 谁只是在 live idle

### 3. message ordering 会变复杂
如果同时存在：
- room transcript
- participant live inbox
- staged run outputs

那消息顺序、归因和可见性都要重新定义。

## 推荐的下一位接手者第一步

不要先改 UI。

先做一轮后端能力确认：
1. 查清 OpenClaw / gateway 是否已有真正 session continuation 能力。
2. 设计 participant session registry 的最小数据结构。
3. 在 `control route` 里加一层可插拔的 delivery 尝试入口，但先只接 local mock / stub。
4. 只有当 backend 直达能力成立后，再把 UI 文案从“留消息”升级回“实时送达”。

## 一句话结论
下一阶段不是继续修“target 文案”，
而是要把 ACPX 从：
- room-target metadata

升级成：
- participant-level live delivery

只有这样，
跨 gateway reviewer 才会真正“听到你”。
