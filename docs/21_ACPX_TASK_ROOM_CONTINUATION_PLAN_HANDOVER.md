# 21 ACPX Task Room Continuation Plan Handover

## 日期
2026-03-24

## 目的
这份 handover 用于承接上一轮 task room chat layout 调整之后的下一阶段工作，重点聚焦：
- 当前 local Codex continuation 在代码里到底已经做到哪里
- 哪些能力已经不是“设想”，而是已经真实接通
- 当前最真实的产品缺口是什么
- 下一会话最合理的实施顺序是什么

这份文档不是再重复 UI layout 交接，而是把焦点收敛到：
- `continue_session`
- local Codex thread continuation
- chat feed 的自然回复闭环

## 当前代码现状总结

### 1. local Codex continuation 已经具备真实技术通路
当前已经不是停留在概念层。

实际代码路径已经成立：
- chat 页会判断当前是否存在可继续的 local Codex session
- control route 已支持 `continue_session`
- runner 已支持根据 `resumeThreadId` 走 continuation
- Codex integration 已支持：
  - `codex exec --json`
  - 解析 `thread.started`
  - 保存 `thread_id`
  - `codex exec resume <thread_id> --json`

关键文件：
- `src/app/tasks/[id]/chat/page.tsx`
- `src/app/api/tasks/[id]/control/route.ts`
- `src/lib/acpx/runner.ts`
- `src/lib/real-agents/codex-agent.ts`

### 2. 当前 continuation 的真实语义是“turn 之间续接”，不是“turn 中注入”
这是当前最关键的产品真相。

当前已经实现的是：
- 某一轮 local Codex 执行完成后
- 平台保存了该轮的 `codexThreadId`
- 用户下一条消息可以触发：
  - `continue_session`
  - 新建一个新的 ACPX run
  - 但这个新 run 会继续同一个 Codex thread

当前还没有实现的是：
- 当当前 turn 仍在执行中
- 用户把消息直接注入同一个 busy harness turn
- 让它在不中断当前运行上下文的情况下原地接着回

因此现在的 continuation 更准确地说是：
- between-turn continuation

而不是：
- mid-turn live injection

### 3. continuation 当前是“新建 run 来继续旧 thread”，不是原地复用同一个 run
`continue_session` 目前并不是在原 run 上追加一条“继续执行”的内部状态。

当前 control route 的实际做法是：
- 先找到目标 run 与 participant
- 读取 participant `controlMetadata` 里的 `codexThreadId`
- 若满足 local Codex continuation 条件
- 直接调用 `executeAcpxTaskRun(...)`
- 创建一个新的单 participant ACPX run
- 把 `resumeThreadId` 与 `continuationMessage` 交给 runner

这意味着：
- 产品语义上，它像“继续当前对话”
- 实现语义上，它其实是“创建一个新的 continuation run，并恢复旧 thread”

这条实现路径目前是合理的，因为：
- 它已经比“简单排队到下一轮”更接近聊天
- 同时不需要依赖长时间保持 CLI stdin 存活

### 4. local Codex thread id 与 child PID 都已经落库
当前 runner 在 local harness 执行时，已经会记录两类关键元数据：

#### child PID
用途：
- 让平台后续能判断本地 harness 进程是否还活着
- 用于 stale-run reconcile

#### Codex thread id
用途：
- 让后续 `continue_session` 能找到同一个 Codex 会话

当前这些信息会写入：
- run `controlMetadata`
- participant `controlMetadata`

其中 thread 相关字段主要包括：
- `codexThreadId`
- `lastSessionThreadId`

### 5. local stale-run / dead-process reconcile 已有第一版
这部分已经不是猜测，而是已有明确实现。

当前 `src/lib/acpx/liveness.ts` 会在若干读接口前执行 reconcile，包括：
- `/api/tasks/[id]`
- `/api/tasks/[id]/runs`
- `/api/tasks/[id]/runs/latest`
- `/api/tasks/[id]/control`

当前规则大意是：
- run 仍显示 `running` 或 `waiting_for_input`
- participant 是 `platform_local`
- 进程注册表中找不到对应进程
- PID 也不存在或不像对应 harness
- 且超过一个短暂 grace period

则平台会自动：
- 收口 participant 状态
- 收口 run 状态
- 清掉 session `activeRunId`
- 发布相应 failure / interrupted / stopped event

这已经解决了一个非常重要的问题：
- “数据库看起来还在跑，但本地 Codex 子进程其实早就没了”

### 6. 当前真正的主问题已经不是 socket，也不是 thread 技术路径
从当前代码和 handover 一起看，下一阶段不应继续把问题误判成：
- socket 没接上
- thread id 取不到
- local Codex 完全不能 continuation

这些里真正已经打通的部分是：
- realtime socket 基本恢复
- local Codex thread continuation 基本接通
- stale local process reconcile 第一版已落地

当前最真实的问题已经变成：
- continuation 的产品语义还不够清晰
- UI 还不够诚实、可观察
- chat feed 还不够“像真实对话”
- busy turn 时仍只能 queue / interrupt

## 当前代码里的关键行为

### 1. chat 页已经会优先判断能否继续当前 session
当前 `/tasks/[id]/chat` 页面里，已经有 continuation 判断逻辑。

大意如下：
- 如果当前 task 还在 `running`
  - 不允许把主按钮当成 continuation
  - 主按钮只能走 queue 语义
- 如果 task 不在 `running`
  - 且 selected run 的 participant 中存在 local Codex
  - 且 participant metadata 里有 `codexThreadId` 或 `lastSessionThreadId`
  - 则主按钮会优先显示为：
    - `继续当前对话`

这说明当前前端已经是“continuation 优先”的第一版，但条件仍较保守。

### 2. control route 已支持 continuation participant 选择与 thread 读取
当前 control route 的 continuation 逻辑已经具备这些能力：
- 支持按 `runId` 找目标 run
- 支持按 room target 或 participant target 选 participant
- 支持从 participant metadata 中提取 continuation thread id
- 若 participant 满足：
  - `platform_local`
  - `codex`
  - 有 thread id
  则允许走 continuation

否则会直接拒绝 continuation 请求。

### 3. runner 已能根据 `resumeThreadId` 走 `codex exec resume`
当前 runner 对 local Codex 的分支已经区分两种模式：

#### 首轮执行
- `executeCodexTask(...)`

#### continuation 执行
- `resumeCodexSession(...)`

判断条件是 participant request 中是否存在：
- `resumeThreadId`
- `continuationMessage`

这说明 continuation 在 runner 层已经不是 TODO，而是实际接线完成的能力。

### 4. Codex CLI 集成已经采用正确的 continuation 技术路径
当前 `src/lib/real-agents/codex-agent.ts` 已明确采用：
- `codex exec --json`
- `codex exec resume <thread_id> --json`

并且会解析 JSON line event：
- 当收到 `thread.started`
  - 记录 thread id
- 当收到 agent message 完成事件
  - 作为 stdout chunk / resolved text 传回上层

这点非常重要，因为它意味着：
- 平台已经找到 local Codex continuation 的真实 CLI 模型
- 不再需要纠结“要不要永远保持 stdin 打开”

## 当前最真实的缺口

### 1. busy turn 时仍不能原地继续
这是当前第一优先级缺口。

用户当前若在 agent 正在执行这一轮时再发一条消息：
- UI 仍不会把消息送进当前 busy turn
- 主按钮会走 queue
- 或由用户主动走 interrupt

因此当前产品体验仍然会像：
- “它在做旧的事”
- “我新的话先被记下来”
- “等后面再说”

这与真正聊天产品的体验仍有明显差距。

### 2. control delivery 语义仍然不够可观察
当前 control route 虽然已经记录了 control message，也有 `deliveryStatus`，但可观察性仍然不足。

现在最缺的是统一、明确地告诉系统与 UI：
- 这条消息是 queued
- 还是 delivered to active thread
- 还是 rejected
- 还是 fallback to queue
- fallback 的原因是什么

如果这层状态不清楚，前端就只能靠推断，用户也会继续感到“不确定它到底有没有送进去”。

### 3. chat feed 仍然把“聊天回复”和“run 控制事件”混在一起
当前 feed 基本是：
- room messages
- run events
按时间合并

这条路没有错，但它目前还缺少视觉和语义上的更强区分：
- 哪些是用户聊天内容
- 哪些是 agent 正在回复
- 哪些只是 run 的控制台噪音

所以现在虽然“数据是对的”，但用户主观体验还不够像聊天。

### 4. `stdout_chunk` 与 `summary` 会造成“回复了两次”的观感
这是当前非常明确的体验 bug。

当前 local live run 的自然结果是：
- agent 最终文本先以 `stdout_chunk` 进入 feed
- 之后同样内容又以 `summary` 再出现一次

于是用户主观上会感觉：
- agent 回答了两遍

这会直接破坏聊天感。

### 5. continuation 目前仍然在 control HTTP 请求里同步执行
这不是当前第一 blocker，但它是值得记录的结构问题。

当前 `continue_session` 的实际行为是：
- control route 在一次 HTTP POST 里
- 直接 await `executeAcpxTaskRun(...)`

这在第一版集成期是可接受的，因为：
- 简单
- 方便验证链路

但从结构上看，后面如果流量、复杂度、失败重试都上来，它不一定是长期最稳的形态。

当前不一定立刻要改，但需要在后续设计中记住这点。

## 下一阶段总体目标

### 核心目标
把 `/tasks/[id]/chat` 从：
- “消息已记录，等待下一轮 run 或 handoff 消费”

推进到：
- “对 local Codex 而言，turn 结束后可以自然继续同一个会话”
- “用户能明确知道自己的消息到底是排队了，还是已经送进了当前 thread”
- “assistant 输出在主 feed 里更像自然聊天，而不是控制台回放”

更进一步的下一步目标才是：
- busy turn 中断后仍沿用同一个 thread 继续

## 推荐实施计划

### Phase 1. 先做真实端到端 continuation 验证
这一步仍然是第一优先级，因为我们要先确认当前链路稳定，再去美化 UI。

目标：
- 用一条新的 local Codex run 做完整验证

验证链路应包括：
1. 首轮 run 正常启动
2. `thread.started` 被正确捕获
3. `codexThreadId` 被正确写入 run / participant metadata
4. 首轮 run 完成后，用户发送第二条消息
5. chat 页主按钮走 `continue_session`
6. control route 选中正确 participant
7. runner 走 `resumeCodexSession(...)`
8. 新 run 成功恢复同一个 Codex thread
9. 新输出成功回到 chat feed
10. 结果能体现 thread 上下文真的被继承，而不是只响应最后一句文本

这一阶段的重点不是“UI 好不好看”，而是要验证：
- continuation thread 是否稳定
- continuation run 切换是否稳定
- 失败时是否能看清楚问题出在哪一层

完成标准：
- local Codex 两轮以上 continuation 可以重复成功
- thread context 可证明被继承
- 前端能切到 continuation 生成的新 run

### Phase 2. 补齐 delivery metadata 与可观察性
这是下一轮最值得立即补的工程层能力。

目标：
- 让每条 control message 都有清晰、可机器读取的投递结果

建议补充的 metadata：
- `targetParticipantId`
- `targetParticipantRole`
- `targetThreadId`
- `deliveryAttempted`
- `deliveryResult`
- `fallbackReason`
- `fallbackAction`
- `continuationRunId`
- `sourceRunId`

建议统一的 delivery 结果枚举至少包括：
- `queued`
- `delivered_to_active_thread`
- `rejected`
- `fallback_to_queue`

这样做的价值是：
- 后端不再只是“做了某件事”
- 而是能清楚告诉 UI：
  - 到底发生了什么

完成后 UI 至少应能明确提示：
- 这条消息已排队，当前 busy turn 不会马上读取
- 这条消息已送入同一个 Codex thread
- continuation 不成立，因此已降级为 queue
- continuation 被拒绝，原因是什么

### Phase 3. 去掉 `stdout_chunk` / `summary` 的双回复观感
这一步用户价值很高，而且实现风险相对不大。

目标：
- 一条 assistant 最终回复，在主聊天流里只让用户感觉看到一次

推荐优先方案：
- 保留 `summary` 数据，继续作为 run metadata 使用
- 但不要再把它按主聊天回复的方式和 `stdout_chunk` 并列展示

不建议一上来就直接删掉 summary event，因为：
- summary 对 run record 和调试仍有价值
- 更稳的做法是先在 UI 端降级展示或去重

最小落地方式：
- 若 `summary.content` 与最后一条 streamed assistant 文本实质相同
- 则在主 feed 中不再把它当成新的 assistant reply 呈现
- 可改为：
  - run summary 元数据
  - sidebar 详情
  - 或折叠状态信息

### Phase 4. 把 conversation feed 改造成“聊天优先，控制事件退后”
这一步是把已有正确数据真正变成“像聊天产品”的关键。

目标：
- 主 feed 首先像对话
- 其次才像运行日志

建议把 feed 中的内容分成几类：

#### 1. 用户消息
- task room room message
- 明确显示 target

#### 2. assistant continuation 回复
- local Codex continuation 的 `stdout_chunk`
- 视觉上更像 assistant reply streaming

#### 3. 轻量系统提示
- continuation started
- queued
- fallback
- interrupted

#### 4. 低优先级 run 诊断事件
- runner started
- participant started
- file modified
- 其他偏控制台性质的信息

目标不是删除控制事件，而是：
- 不让这些事件抢主角位置

### Phase 5. 重构 composer 状态模型
当前 composer 虽然已经有一些诚实提示，但状态推导还比较分散。

建议把前端 send 逻辑收敛成一个明确的 mode：
- `continue_session`
- `queue_only_busy`
- `queue_then_start_new_run`
- `interrupt_then_next_run`

然后由这个单一状态统一决定：
- 主按钮文案
- 次按钮是否出现
- 顶部 hint 文案
- 成功后的 notice 文案
- 失败后的 fallback 文案

这样可以避免：
- 同一套语义分散在多个 `if` 分支里
- 前端提示和后端真实行为再次漂移

这一步的目标是：
- 在用户点击发送前，就让用户知道“这次发送到底会做什么”

### Phase 6. 增加 continuation 专属 event
这一步对聊天闭环会很有帮助。

建议新增轻量事件，例如：
- `session_continuation_started`

建议 metadata 可包含：
- `sourceRunId`
- `continuationRunId`
- `participantId`
- `participantRole`
- `threadId`
- `controlMessageId`

UI 中可以把它渲染成一条很轻的系统提示，例如：
- “正在继续 implementer 的同一 Codex 会话”

这样用户就不会只看到：
- “为什么突然又出现了一个新 run”

而会更自然地理解成：
- “同一个对话正在继续”

### Phase 7. 补 continuation 失败 / fallback 的明确策略
当前 continuation 成功路径已初步成立，但失败策略还不够产品化。

需要明确的问题包括：
- thread id 不存在怎么办
- thread id 失效怎么办
- selected participant 不支持 live session control 怎么办
- continuation run 创建失败时：
  - 是直接报错
  - 还是自动 fallback 为 queue

建议至少先做到：
- 所有 continuation failure 都有明确错误原因
- 若 fallback 发生，必须写进 metadata
- UI notice 必须能告诉用户：
  - 失败了
  - 为什么失败
  - 系统是否已自动改为 queue

### Phase 8. 再探索“mid-turn interrupt + same-thread resume”
这是更接近真正聊天产品体验的下一步，但难度明显高于当前第一版。

目标应定义得非常清楚：
- 当 local Codex 当前 turn 还在执行时
- 用户可以选择：
  - 打断当前 turn
  - 然后仍沿用同一个 Codex thread 继续

注意：
- 这并不是“把消息热注入到当前正在运行的 CLI 进程”
- 更现实的定义应是：
  - 先中断当前 invocation
  - 再对同一个 thread 做 `exec resume`

如果这一步能做好，体感会比现在更接近真正聊天。

### Phase 9. 最后再回头处理 remote liveness 与 approval / input 真交互
这两件事仍然重要，但它们不应再排在 continuation 主链路前面。

原因是：
- 如果 local continuation 语义本身还没收稳
- 那么 approval / input request 就仍然会停留在“发模板消息 + 下一轮重跑”的层面

因此更合理的顺序是：
1. 先把 local Codex continuation 做实
2. 再把 permission / input / choice 交互接回同一条会话链路
3. 再处理 remote quiet / stalled / dead 的更完整产品模型

## 建议下一会话的实际执行顺序

### P0. 先跑一次真实 local Codex continuation 验证
不要再停留在阅读和推断。

下一会话最值得先做的是：
- 直接跑一条新的 local Codex run
- 拿到 thread id
- 再从 chat 页发第二条 continuation 消息
- 看完整 event sequence 与最终 feed 效果

### P1. 立即补 delivery metadata
这是当前性价比最高的一步。

原因：
- 它能同时帮助后端调试、前端诚实提示、以及后续 handover

### P2. 处理 duplicate reply 观感
优先解决：
- `stdout_chunk`
- `summary`
重复显示的问题

### P3. 把 composer 改成 continuation-first 的显式模式
目标：
- 当前可 continue 时，主按钮明确继续当前对话
- 当前 busy 时，明确只能 queue
- 不要让用户靠猜

### P4. 做 continuation 专属系统事件与 feed 降噪
目标：
- 让“继续当前对话”在 UI 上真正像一次自然续接

### P5. 再探索 mid-turn interrupt + same-thread resume
这是下一层难度，不建议抢在前面。

## 推荐下一会话先读
1. `docs/16_ACPX_INTERACTIVE_RUN_CONTROL_PLAN.md`
2. `docs/19_ACPX_TASK_ROOM_CONTROL_HANDOVER.md`
3. `docs/20_ACPX_TASK_ROOM_CHAT_LAYOUT_HANDOVER.md`
4. `docs/21_ACPX_TASK_ROOM_CONTINUATION_PLAN_HANDOVER.md`
5. `src/lib/acpx/liveness.ts`
6. `src/lib/acpx/runner.ts`
7. `src/lib/real-agents/codex-agent.ts`
8. `src/app/api/tasks/[id]/control/route.ts`
9. `src/app/tasks/[id]/chat/page.tsx`

## 一句话结论
当前 ACPX task room 已经跨过了最关键的技术门槛：
- local Codex continuation 不是假设，而是已经具备真实通路

下一阶段真正要做的，不再是“证明 continuation 能不能做”，而是：
- 把它做得诚实、稳定、可观察、像聊天。
