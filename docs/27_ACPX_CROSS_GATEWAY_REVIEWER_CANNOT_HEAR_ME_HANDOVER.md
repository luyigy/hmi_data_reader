# 27 ACPX Cross Gateway Reviewer Cannot Hear Me Handover

## 日期
2026-03-24

## 背景
在 `26_ACPX_CLEAN_CHAT_LAYOUT_AND_COLLAPSIBLE_PANELS_HANDOVER.md` 之后，
task room 的页面形态已经更接近 chat-first workspace：
- 聊天主区更干净
- room details 可折叠
- inspector 可折叠
- 左侧导航也支持收起

但真实使用中又暴露出一个更关键的行为问题：
- 用户把消息明确发给 `reviewer · Windows Gateway 10.0.8.3 / claude`
- 页面也显示 target 正确
- 但这条消息并没有被远端 reviewer 立刻“听到”
- 系统反而提示：
  - 当前 `implementer · Platform Local / codex` 忙碌中
  - 这条消息已记入 task room
  - 后续 handoff 或下一轮运行才会读取

用户的直接感受就是：
- 为什么另一个 gateway 上的 reviewer 听不到我

## 用户当前真实现象

从页面截图和当前行为看：
- 当前 active run 里 `implementer / codex` 正在 `running`
- `reviewer / Windows Gateway / claude` 仍是 `pending`
- 用户在 composer 里把 target 切到了 reviewer
- 发出的消息气泡也正确显示为：
  - 发给：`reviewer · Windows Gateway 10.0.8.3 / claude`
- 但紧接着 control message 显示：
  - `delivery: queued`
  - `收到排队消息`

同时底部 notice 明确写的是：
- 当前 implementer 忙碌中
- 这条消息已记入 task room
- 后续 handoff 或下一轮运行才会读取

这说明当前系统虽然支持“消息 target 到某个 participant”，
但在 active run 正在执行期间，
消息并不会直接下发给另一个尚未开始的远端 participant。

## 当前更准确的问题判断

### 1. 现在的 participant targeting 更像“逻辑标记”，不是“实时路由”
当前页面上的：
- 发给整个任务
- 发给单个参与方
- 发给全部参与方

至少在用户心智里，
看起来像是一个实时路由能力。

但当前真实实现更接近：
- 先写入 task room
- 再由当前运行流程在后续阶段决定是否读取

也就是说：
- target 目前更多是 message metadata
- 还不是 live delivery guarantee

### 2. active run 当前仍然是单线程/单控制目标主导
从当前 ACPX 行为看，
active run 在运行时的核心控制对象仍然是：
- 正在跑的那个 active participant

当 `implementer / codex` 正在 streaming 时，
系统不会因为用户把消息 target 到 reviewer，
就即时切换去唤醒：
- 远端 `reviewer / claude`

于是用户看到的结果就是：
- target 对了
- 但 reviewer 没听到

### 3. UI 语义已经超前于底层调度能力
这是最关键的问题。

现在 UI 已经在表达：
- 你可以直接给某个 participant 发消息

但底层实际只保证：
- 把消息记到 room
- 后续由 orchestration/handoff 再决定读取

所以目前最大的落差不是按钮坏了，
而是：
- 产品语义像“直达”
- 实际行为还是“排队”

## 为什么这件事重要

如果不修，
用户会自然形成一个错误心智：
- 以为 reviewer 是一个独立在线 agent
- 以为只要 target 它，它就会立刻收到消息

但当前真实行为并不是这样。

这会继续造成三类混乱：
- 为什么 target 了 reviewer 但 implementer 那边显示 queued
- 为什么远端 gateway 连通性 OK，但 reviewer 还是不回复
- 为什么 participant selector 看起来像实时聊天对象，但实际上只是 run context 标记

## 推荐排查方向

### Phase 1. 先澄清当前语义
先确认当前系统对 participant-targeted room message 的真实处理路径：
- 是否只是写入 `task room message.targetParticipantKey`
- 是否只有 active participant / continuation run 会读取
- 是否 staged orchestration 的后续 participant 才会看到这些消息

优先要查的文件包括：
- [page.tsx](/data1/code/agent-platform-v2/src/app/tasks/[id]/chat/page.tsx)
- [control route](/data1/code/agent-platform-v2/src/app/api/tasks/[id]/control/route.ts)
- [task-room.ts](/data1/code/agent-platform-v2/src/lib/task-room.ts)
- [runner.ts](/data1/code/agent-platform-v2/src/lib/acpx/runner.ts)

### Phase 2. 明确要不要支持“非 active participant 直达消息”
这是一个产品决策点。

可能有两条方向：

#### A. 保守路线
不支持 reviewer 实时直达，
那就必须把 UI 说清楚：
- 这只是“给后续该 participant 的上下文留言”
- 不是实时送达

#### B. 进取路线
支持对非 active participant 的实时直达，
那就要新增：
- participant-level live routing
- gateway push / remote chat session
- 或独立 reviewer session

这会是更大的能力扩展。

### Phase 3. 在 UI 上避免误导
在真正支持“直达”之前，
participant target 的文案应该更诚实，例如：
- `发给某参与方（供后续读取）`
- 或在 active run 忙碌时明确提示：
  - 当前只会排队，不会实时送达给 reviewer

## 一句话结论
当前 `reviewer · Windows Gateway 10.0.8.3 / claude` “听不到你”，
不是因为 target 丢了，
而更像是：
- 当前 participant targeting 还只是 task room 层的排队上下文
- 并没有真正打通到非 active participant 的实时 delivery

下一阶段必须先把这层语义查清楚，
再决定是：
- 继续诚实地做“排队给后续 participant”
- 还是真正补上“跨 gateway participant 实时收消息”的能力。
