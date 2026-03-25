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

## 2026-03-25 后续补充

在本 handover 对应的桥接提交之后，又补了一轮 **generic ACPX session continuation**，对应提交：

- `8d3cebd` `Add generic ACPX session continuation for Claude and remote harnesses`

这一轮的意义不是改掉 Plan C 方向，而是把 Plan C 从“只有 stable identity / ACPX bridge”继续推进到“开始真的让更多 harness 用同一套 continuation 语义”。

### 这轮后续补充做了什么

#### 1. ACPX continuation metadata 不再只围绕 Codex `threadId`

现在 ACPX 开始同时追踪：

- `lastSessionId`
- `lastSessionKind`
- `resumeSessionId`
- `continuationSessionKind`

也就是说 continuation 不再被硬编码成：

- 只有 `codexThreadId`

而是开始变成一套更通用的 session abstraction。

关键实现：

- [acpx/types.ts](/data1/code/agent-platform-v2/src/lib/acpx/types.ts)
- [acpx/session-tracking.ts](/data1/code/agent-platform-v2/src/lib/acpx/session-tracking.ts)
- [acpx/runner.ts](/data1/code/agent-platform-v2/src/lib/acpx/runner.ts)

#### 2. local Claude 现在已经接入真实 session continuation

这轮不是再做 prompt replay，而是直接利用 Claude CLI 的真实 session id：

- 启动时读取 `session_id`
- continuation 时使用 `--resume <session_id>`

关键实现：

- [claude-agent.ts](/data1/code/agent-platform-v2/src/lib/real-agents/claude-agent.ts)

这意味着：

- `platform_local + claude`
- `ACPX + platform_local + claude`

现在都已经不再是“每轮全新会话”。

#### 3. remote SSH 的 Codex / Claude 也开始走真实 resume

这轮把 remote harness 改成：

- remote codex: 可复用已有 thread id，走 `codex exec resume ...`
- remote claude: 可复用已有 session id，走 `claude --resume ...`

关键实现：

- [ssh-executor.ts](/data1/code/agent-platform-v2/src/lib/remote-harness/ssh-executor.ts)

注意这里仍然是：

- 每次 continuation 仍然会新起一个远端 CLI 进程

但它已经不是“fresh conversation”了，
而是：

- 新进程附着到同一个远端 codex thread / claude session

所以从 continuation 语义上，已经明显前进了一大步。

#### 4. ACPX control / Task Chat UI 不再假设 continuation 只属于 local Codex

这轮把 ACPX task control route 和 task chat UI 一并放宽为：

- 只要 participant 有可续接的 session id
- 就可以作为 continuation target

而不是旧逻辑那样只找：

- `platform_local + codex`

关键实现：

- [task control route](/data1/code/agent-platform-v2/src/app/api/tasks/[id]/control/route.ts)
- [task chat page](/data1/code/agent-platform-v2/src/app/tasks/[id]/chat/page.tsx)

#### 5. Live Room 通过 ACPX bridge 时，也会传递 generic continuation session

这意味着 live-room 侧现在不只是传：

- `resumeThreadId`

也开始优先传：

- `resumeSessionId`
- `continuationSessionKind`

关键实现：

- [live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts)

### 这轮后续补充之后，能力矩阵如何变化

更准确的说法现在变成：

| 路径 | 当前 continuation 状态 | 说明 |
| --- | --- | --- |
| `platform_local + codex` | 是 | 真实 Codex thread continuation |
| `platform_local + claude` | 是 | 真实 Claude session continuation |
| `ACPX + platform_local + codex` | 是 | 已接入 generic ACPX continuation |
| `ACPX + platform_local + claude` | 是 | 已接入 generic ACPX continuation |
| `ACPX + remote_ssh + codex` | 基本是 | 新起进程，但会 resume 同一 Codex thread |
| `ACPX + remote_ssh + claude` | 基本是 | 新起进程，但会 resume 同一 Claude session |
| `Live Room + remote_ssh` | 通过 ACPX 基本接通 | 已经开始消费同一 continuation identity / session |

这里之所以写“基本是”，是因为：

- 远端现在虽然可以 resume 同一 session/thread
- 但仍然是“每轮新起一个远端 CLI 进程再附着回该 session”
- 还不是那种长期常驻、可原地 append 输入的 live remote daemon 模式

不过从本文定义的 true continuation 角度看，
它已经不再是单纯 transcript replay 了。

### 这轮后续补充之后，仍然没有完全结束的地方

#### 1. Live Room UI 还没有完全直接消费 ACPX continuation/run event model

后端语义已经更统一了，
但前端 room 可视化状态还不是完全 ACPX-native。

#### 2. remote live session control 仍然偏“process control”，不是“long-lived attached transport”

现在 remote continuation 已经能恢复同一 session，
但 interrupt / append / watchdog 更多仍然建立在：

- 新起 CLI
- 追踪当前 child process

之上。

如果后续要做更强的：

- append message to active remote session
- richer remote waiting-user state
- mid-session user interaction

可能还需要更长期的 remote agent transport / daemon 抽象。

#### 3. gateway_openclaw 仍不在这轮真实 continuation 范围内

本轮主要补的是：

- local Claude
- remote Codex
- remote Claude

`gateway_openclaw` 还没有被纳入同等级 continuation 语义。

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
