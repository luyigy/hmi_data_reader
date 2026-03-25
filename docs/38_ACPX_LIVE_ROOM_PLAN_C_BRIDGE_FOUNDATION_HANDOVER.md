# 38 ACPX Live Room Plan C Bridge Foundation Handover

## 日期
2026-03-25

## 本文目的

记录本轮已经完成的 **Plan C 基础桥接工作**：

- 不是继续给 `Live Room` 叠一层独立 remote session manager
- 而是开始把 `Live Room` 的执行锚定到 ACPX 的 `task / taskSession / taskRun / participant` 体系

这份 handover 重点说明：

1. 这轮已经做了什么
2. 现在哪些能力是真的已经改善了
3. 哪些能力仍然**没有**真正完成
4. 下一位 agent 应该从哪里继续

## 这轮已完成内容

### 1. Live Room 现在会自动拥有一个 backing ACPX task

新增逻辑：

- 每个 `Live Room` 现在会同步一个 `sourceTask`
- 这个 task 的 `executionMode = acpx`
- room 内所有可回复成员会被同步成 ACPX participants

关键实现：

- [live-room.ts](/data1/code/agent-platform-v2/src/lib/live-room.ts)
  - `syncLiveRoomSourceTask(...)`
  - `buildLiveRoomAcpxParticipant(...)`
  - `getLiveRoomParticipantContinuationKey(...)`

当前会在这些时机同步 source task：

- 创建 room
- room patch
- 添加 member
- 发消息前
- 更新 topic

相关文件：

- [live-rooms route](/data1/code/agent-platform-v2/src/app/api/live-rooms/route.ts)
- [live-room patch route](/data1/code/agent-platform-v2/src/app/api/live-rooms/[id]/route.ts)
- [members route](/data1/code/agent-platform-v2/src/app/api/live-rooms/[id]/members/route.ts)
- [messages route](/data1/code/agent-platform-v2/src/app/api/live-rooms/[id]/messages/route.ts)
- [topic route](/data1/code/agent-platform-v2/src/app/api/live-rooms/[id]/topic/route.ts)

### 2. Live Room member 现在有稳定的 ACPX participant identity

本轮新增了：

- `continuationKey`

它的用途是：

- 不再只靠 `(backend/gateway/harness/role/agentId)` 猜“是不是同一个 participant”
- 而是给 live-room member 一个明确的、稳定的 continuation identity

关键实现：

- [acpx/types.ts](/data1/code/agent-platform-v2/src/lib/acpx/types.ts)
- [task-room-targets.ts](/data1/code/agent-platform-v2/src/lib/task-room-targets.ts)
- [acpx/session-tracking.ts](/data1/code/agent-platform-v2/src/lib/acpx/session-tracking.ts)
- [acpx/runner.ts](/data1/code/agent-platform-v2/src/lib/acpx/runner.ts)

### 3. Live Room message 会镜像到 backing task room

现在 `postLiveRoomMessage(...)` 不再只写 live-room 自己的消息表。

如果 room 已经有 `sourceTask`：

- 同一条 live-room message 会被镜像到 task room
- 如果有明确 target member，则会写成 participant-targeted task-room message
- 这样 ACPX 后续执行时可以直接读取统一 task-room transcript/context

关键实现：

- [live-room.ts](/data1/code/agent-platform-v2/src/lib/live-room.ts)
  - `postLiveRoomMessage(...)`

### 4. Live Room reply execution 已切到 ACPX single-participant run

这是本轮最关键的变化。

之前：

- `Live Room` reply 直接走：
  - local codex / claude
  - remote ssh
  - gateway openclaw

现在：

- `Live Room` reply 先把目标 member 映射成 ACPX participant
- 再用 ACPX 跑一个 single-participant run
- 并尝试用最新 participant session 信息寻找 continuation state

关键实现：

- [live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts)
  - `executeLiveRoomReplyViaAcpx(...)`
  - `processLiveRoomDelivery(...)`

### 5. interrupt 开始优先对接 ACPX active participant

本轮把 live-room interrupt 往 ACPX active run/participant 上接了一步：

- 如果当前 room 的 backing task session 上有 active run
- 并且能找到 continuationKey 对应的 participant
- 就会优先对该 ACPX participant 发 interrupt

否则才 fallback 到旧的 live-room-local registry 逻辑。

关键实现：

- [live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts)
  - `interruptLiveRoomMemberReplies(...)`

### 6. interrupt / failure 文案做了第一轮 normalization

本轮还补了一个很现实的问题修复：

- SSH known-host warning 不应直接显示成 room failure reason
- 用户主动 interrupt 不应继续显示成 generic raw stderr failure

当前已经做的处理：

- strip 掉典型 `Warning: Permanently added ... known hosts` 文案
- `Interrupted by user` 不再继续发一条误导性的 generic failure system message

关键实现：

- [live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts)
  - `normalizeLiveRoomExecutionError(...)`

## 这轮之后，真正改善了什么

### 已经真实改善的部分

#### 1. Live Room 不再只是“独立直调层”

它现在已经开始绑定：

- ACPX task
- ACPX task session
- ACPX participant identity

也就是说，
Plan C 不再只是文档方向，
而是已经有了第一层真实代码落点。

#### 2. continuation identity 开始统一

虽然还没做到“所有 harness 都真 resume”，
但至少现在：

- `Live Room member -> stable ACPX participant continuationKey`

这个映射已经存在。

这对后续继续做：

- append message
- continue session
- interrupt session
- session tracking

非常关键。

#### 3. transcript source 开始统一到 task-room 语义

这意味着后续如果继续推进 ACPX，
就不必再同时维护两套完全平行的上下文输入模型：

- live-room transcript 一套
- task-room transcript 一套

现在已经开始汇合。

## 这轮之后，哪些事情仍然没有真正完成

这一节非常重要。

### 1. 这还不等于“all-path true session continuation 已完成”

虽然 `Live Room` 已经切到 ACPX bridge foundation，
但**底层 harness 能否真正继续同一个 session**，
仍然取决于 harness 自己是否支持。

目前最关键的事实仍然是：

- local codex: 真 continuation 已有
- 其他路径：大多数还没有真正的 native continuation

所以现在准确说法应该是：

- **架构桥接已经朝着 true continuation 统一模型前进**
- **但 all-path true continuation 本身还没有真正全部实现**

### 2. remote_ssh 仍然没有真正的 native remote session resume

本轮已经让 `Live Room` reply 通过 ACPX 发起，
但 ACPX 里面的 remote harness 目前仍然不是成熟的“native remote thread/session resume”能力。

也就是说：

- `Live Room -> ACPX` 这层现在更统一了
- 但 `ACPX -> remote_ssh harness` 这一层还需要继续升级

### 3. local claude / remote claude 的 continuation 仍未真正打通

当前代码基础里：

- Codex continuation 最成熟
- Claude 仍然缺乏同等级的 session/thread resume 机制

所以这轮不是“Claude continuation solved”，
只是把 Claude 也放进了统一 Plan C 架构方向里。

### 4. Live Room 还没有直接消费 ACPX event stream 来更新 UI

当前 room UI 仍然主要看 live-room 自己的 pending/reply 状态。

还没有完全变成：

- “UI 直接消费 ACPX participant/run events”

所以状态统一还只是做到了后端基础层的一部分。

## 下一位 agent 最应该继续做什么

### 第一优先级

把 **ACPX participant continuation capability** 做成真正可复用能力，而不是目前只对 local codex 最完整。

重点看：

1. `remote_ssh + codex`
2. `platform_local + claude`
3. `remote_ssh + claude`

### 第二优先级

把 `Live Room` 的 interrupt / continue / append message 继续直接对接 ACPX control model。

也就是说后续应尽量减少：

- live-room 自己维护的中间控制语义

而更多复用：

- ACPX control
- ACPX participant session tracking
- ACPX run events

### 第三优先级

让 UI 逐步能看见 ACPX continuation 状态，而不只是 live-room 自己的 pending summary。

## 建议下一步切入点

最推荐的技术切入点：

1. 先完善 [acpx/session-tracking.ts](/data1/code/agent-platform-v2/src/lib/acpx/session-tracking.ts)
2. 再增强 ACPX remote/local harness adapters，使 continuation 不再只对 codex 最完整
3. 然后把 live-room interrupt / continue 全量收敛到 ACPX control API

## 一句话总结

这轮已经把 `Live Room` 从“独立 reply 调度层”推进到了 **ACPX-backed bridge foundation**。

这非常关键，因为它解决的是方向问题：

- continuation identity 开始统一
- room transcript 开始汇合到 task-room / ACPX 语义
- live-room reply execution 已经不再完全绕过 ACPX

但它还不是终点。

当前更准确的说法是：

- **Plan C 的桥已经搭起来了**
- **真正 all-path native continuation 还需要继续往 ACPX/harness 层打通**
