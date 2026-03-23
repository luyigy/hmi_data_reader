# 16 ACPX 交互式运行控制方案

## 日期
2026-03-23

## 目标
把 ACPX 从“提交任务后等待结果”的一次性任务执行器，升级为“用户可随时介入、可中断、可排队指令、可持续协作”的交互式任务运行空间。

这个阶段要解决的不是单纯的超时配置问题，而是下面这些更根本的问题：
- 不能只靠硬编码 timeout 判断任务失败
- 用户需要在任务运行中随时介入
- 用户消息不应该都立刻打断执行
- 需要区分“Agent 正在安静工作”和“Agent 已经卡死/异常”
- 不同 harness 对中断、恢复、即时注入消息的支持能力不同，平台不能假装它们完全一致

## 为什么必须先有计划
这个问题跨越了：
- 任务运行状态建模
- harness 生命周期管理
- 用户消息投递语义
- 前端 task room 交互
- 本地 / 远端 gateway 能力差异
- 异常检测与 watchdog 策略

如果没有一个明确方案，后续很容易继续演化成：
- 一边在 UI 上加按钮
- 一边在 runner 里硬塞条件分支
- 最后不同 harness 行为不一致，用户也不知道“发送消息”“立即打断”“停止运行”到底意味着什么

所以这一轮的重点不是马上写所有代码，而是先锁定交互式运行控制模型。

## 当前现状

### 已有能力
- ACPX 已支持：
  - 任务创建
  - participant 配置
  - `TaskRun` / `TaskRunParticipant` / `TaskRunEvent`
  - live event console
  - task room 基础消息流
- 用户已经可以在 task room 中发送消息。
- 当前后续 participant / rerun 已经可以读取 task room 中的上下文消息。

### 当前明显不足
- timeout 仍然是硬编码的技术兜底，不是用户可理解的运行策略。
- 用户消息目前只是“影响后续阶段”，不能精确定义为：
  - 排队
  - 立即注入
  - 紧急中断
- 平台当前不能可靠判断：
  - agent 只是暂时无输出
  - 还是已经卡住
  - 还是已经异常退出
- 当前没有正式的“运行控制动作”模型。
- 当前没有 per-harness capability matrix。
- direct harness 当前还没有稳定保证：
  - 可写工作区
  - 正确权限模式
  - CLI 主动向用户请求确认/输入时的平台接入能力

## 产品目标

### 用户在 task room 里应该能做的事
用户至少应当可以：
- 在任务开始前，先和参与方讨论策略
- 在任务执行过程中发送补充说明
- 选择消息是：
  - 仅排队，稍后处理
  - 立即介入
- 在紧急情况下立刻停止当前运行
- 看懂当前 agent 是：
  - 正在活跃输出
  - 正在工作但暂时安静
  - 等待用户输入
  - 已被中断
  - 已失败

### 产品形态目标
`/tasks/[id]/chat` 不应再只是日志页面。

它应该演进为真正的 `task room`，至少包含：
- room 消息流
- 用户输入区
- run history
- 当前 run console
- 运行状态指示
- 运行控制按钮

## 核心产品决策

### 1. 不再把 timeout 当作主要失败判断
timeout 不应再是“任务是否失败”的主要机制。

推荐改成三层机制：

#### 第一层：运行状态
- `pending`
- `running`
- `waiting_for_input`
- `interrupted`
- `completed`
- `failed`
- `stopped`

#### 第二层：活动状态
描述 agent 当前活跃程度，而不是最终命运：
- `streaming`
- `quiet`
- `stalled`
- `waiting_user`
- `terminating`

#### 第三层：可选 watchdog 策略
watchdog 不是硬失败逻辑，而是运行保护策略。

推荐区分：
- `maxRuntimeMs`
  - 用户可选
  - 可为空
- `inactivityWarningMs`
  - 超过这个时间无新活动，只给警告，不自动失败
- `inactivityFailMs`
  - 超过这个时间并且判断为无生命迹象，才标记失败或建议用户介入

结论：
- timeout 可以存在，但必须从“硬编码默认行为”变成“显式策略”。

### 2. 用户消息必须区分两种投递模式

#### 模式 A：排队消息
用户的消息进入 task room，并标记为：
- `deliveryMode = queued`

含义：
- 不强制打断当前执行
- 在下一次合适的 handoff 点送达
- 适合：
  - 新增背景信息
  - 补充约束
  - 下一个阶段要注意什么

#### 模式 B：立即介入
用户的消息标记为：
- `deliveryMode = immediate`

含义：
- 要求平台尽快对当前运行做强介入
- 可能触发：
  - cooperative interrupt
  - stop + restart with context
  - 未来支持真正 session injection 的 harness 上，直接即时注入

### 3. 用户至少要有两个运行控制动作

#### 动作 1：紧急中断
用户希望当前运行立刻停止。

建议动作名：
- `interrupt_now`

适用：
- Agent 明显跑偏
- 会造成破坏性改动
- 用户决定立即重定向方向

#### 动作 2：排队消息
用户希望不打断当前运行，但后续必须看到这条消息。

建议动作名：
- `queue_message`

未来还可以补第三个动作：
- `stop_run`
  - 比 `interrupt_now` 更强，表示终止整个 run，不再尝试继续

### 4. 平台不能假设所有 harness 支持同样的交互控制
必须显式引入 capability 概念。

建议每个 harness 至少声明：
- `supportsQueuedUserMessages`
- `supportsImmediateInterrupt`
- `supportsResumeAfterInterrupt`
- `supportsLiveSessionControl`
- `supportsSoftStop`

原因：
- 本地 Codex CLI
- 本地 Claude Code
- Gateway OpenClaw agent
- 未来 Gemini CLI

这些能力并不相同。

如果没有 capability matrix，前端 UI 会误导用户，以为所有按钮都等价有效。

### 5. direct harness 的权限请求与输入请求必须进入 task room
对于 `codex`、`claude code` 这类 direct harness，平台必须假设运行中可能出现：
- permission request
- choice request
- input request
- confirmation request

这些都不能只停留在服务器侧 CLI stderr/stdout 中。

平台需要把它们提升成显式运行状态与可交互 UI：
- run / participant 进入 `waiting_for_input`
- task room 中出现请求卡片
- 用户可：
  - 同意
  - 拒绝
  - 选择某个选项
  - 提交补充输入

这点对 human-in-the-loop ACPX 是硬要求，不是后期体验优化。

### 6. direct harness 必须支持真正可写工作区
如果 ACPX 使用 direct `codex` / `claude code` 作为 coding harness，则平台需要明确保证：
- working directory 指向目标 repo
- harness 处于可写环境，而不是只读
- 权限/approval 模式符合产品预期
- harness 修改的文件能被平台后续 run 与 UI 正确看见

否则 direct harness 只能做分析，不能稳定承担真实编码任务。

## 数据模型建议

### 1. `TaskRun` 扩展字段
建议增加：
- `controlState`
  - `normal`
  - `interrupt_requested`
  - `stop_requested`
- `activityState`
  - `streaming`
  - `quiet`
  - `stalled`
  - `waiting_user`
  - `terminating`
- `lastActivityAt`
- `lastStdoutAt`
- `lastStderrAt`
- `watchdogConfig`
  - JSON
- `controlMetadata`
  - JSON

### 2. `TaskRunParticipant` 扩展字段
建议增加：
- `activityState`
- `lastActivityAt`
- `interruptSupported`
- `resumeSupported`
- `sessionControlSupported`
- `controlMetadata`

### 3. 新增 `TaskRunControlMessage`
表示与某个 run 绑定的控制型用户消息，而不是普通聊天消息。

建议字段：
- `id`
- `taskRunId`
- `taskId`
- `roomMessageId`
- `participantId`
  - 可空
- `senderUserId`
- `senderName`
- `deliveryMode`
  - `queued`
  - `immediate`
- `deliveryStatus`
  - `pending`
  - `delivered`
  - `superseded`
  - `rejected`
- `controlAction`
  - `queue_message`
  - `interrupt_now`
  - `stop_run`
- `content`
- `metadata`
- `createdAt`
- `processedAt`

### 4. 继续保留普通 room 消息
不要把 task room 里的所有消息都强行等同于运行控制。

因为 task room 里可能还有：
- 普通讨论
- 系统通知
- 参与方总结
- 用户备注

所以更合理的做法是：
- room 消息负责“对话可见性”
- control message 负责“运行控制语义”

## 运行控制语义设计

### 场景 A：用户发排队消息
流程：
1. 用户在 task room 输入消息
2. 选择 `排队发送`
3. 消息写入 room
4. 同时生成 `TaskRunControlMessage(deliveryMode=queued)`
5. 当前运行继续
6. 下一次 participant handoff 或 rerun 时，这条消息进入 prompt context

### 场景 B：用户要求立即介入
流程：
1. 用户在 task room 输入消息
2. 选择 `立即介入`
3. 消息写入 room
4. 生成 `TaskRunControlMessage(deliveryMode=immediate)`
5. 平台检查当前 harness capability
6. 如果支持：
  - 发起 soft interrupt / session injection
7. 如果不支持：
  - 标记当前 participant 进入 interrupt_requested
  - stop 当前进程
  - 用已有上下文 + 用户新消息启动下一段执行

### 场景 C：用户紧急停止
流程：
1. 用户点击 `停止运行`
2. `TaskRun.controlState = stop_requested`
3. 平台尝试：
  - kill 当前本地进程
  - 或向远端 gateway 发 stop / cancel
4. run 最终进入：
  - `stopped`
  - 或 `failed`
  - 视实现而定

## 错误检测与“静默但活着”的判断策略

### 不能只看 stdout/stderr
很多 coding harness 会出现长时间安静：
- 读文件
- 思考
- 规划
- 执行内部工具

所以“没有输出”不等于失败。

### 推荐的判断信号
优先级从强到弱：

1. 进程是否仍存在
- 本地 harness：child process 是否仍 alive

2. session / gateway 是否仍有生命迹象
- 如果远端支持 heartbeat / status event，优先使用

3. 最近活动时间
- `lastActivityAt`

4. 最近输出时间
- `lastStdoutAt`
- `lastStderrAt`

### 推荐判断逻辑
- 进程已退出且非成功：
  - `failed`
- 进程仍在且最近有活动：
  - `running + streaming`
- 进程仍在但一段时间无活动：
  - `running + quiet`
- 超过 inactivity warning 阈值：
  - `running + stalled_warning`
- 超过 inactivity fail 阈值且没有生命迹象：
  - `failed` 或 `needs_attention`

更推荐先做：
- `needs_attention`
而不是直接失败

因为很多时候让用户来决定“继续等”还是“立即打断”更合理。

## 前端方案

### task room 页面应新增的控制
- `排队消息`
- `立即介入`
- `停止运行`

### 页面上应显示的状态
- 当前 run 状态
- 当前 participant 状态
- activity 状态：
  - 正在输出
  - 安静工作中
  - 长时间无活动
  - 等待用户输入
  - 正在中断

### run history 中要体现
- 哪轮 run 被用户中断过
- 哪轮 run 收到了 queued message
- 哪轮 run 收到了 immediate injection

### room 消息展示建议
每条消息最好显示类型：
- `用户消息`
- `系统消息`
- `队列消息`
- `立即介入`
- `参与方总结`

## 后端实现建议顺序

### 第 1 步：先写运行控制 contract
先不要急着做 UI 按钮逻辑。

先定义：
- run control actions
- activity states
- watchdog config
- harness capabilities

落点建议：
- `src/lib/acpx/types.ts`
- `src/lib/acpx/control.ts`

### 第 2 步：加入 control message 持久化
把普通 room message 和 control message 的关系理清。

先能稳定记录：
- 哪条用户消息是 queued
- 哪条是 immediate
- 哪条已经被处理

### 第 3 步：本地 harness 先支持 interrupt / soft stop
优先做本地 Codex / Claude。

因为本地 child process 生命周期更可控，最适合先跑通：
- interrupt
- stop
- restart with context

### 第 4 步：把 gateway harness 能力做成 capability matrix
先不要承诺所有远端 gateway 都支持立即注入。

先让平台能明确知道：
- 这个 harness 只能 queued
- 这个 harness 支持 interrupt
- 这个 harness 支持 stop + resume

### 第 5 步：前端 task room 加控制面板
到这个阶段再加：
- 排队消息
- 立即介入
- 停止运行

### 第 6 步：最后再处理 watchdog 与智能告警
因为它依赖前面状态模型先稳定。

## 建议暂时不要做的事
- 不要现在就承诺所有 harness 都能 mid-run 实时插话
- 不要把 timeout 全删掉而没有任何 watchdog
- 不要把所有 room 消息都默认视为立即控制指令
- 不要把“静默”直接当失败

## 本轮明确结论

### 结论 1
timeout 不应继续硬编码为主要失败逻辑。

### 结论 2
需要正式引入：
- queued user message
- immediate intervention
- emergency interrupt / stop

### 结论 3
需要区分：
- run state
- activity state
- control state

### 结论 4
必须补 harness capability matrix。

### 结论 5
`/tasks/[id]/chat` 的目标形态应当是：
- task room
- not just console

## 下一轮推荐起手实现
1. 在类型层加：
  - control action
  - activity state
  - harness capability
2. 设计 `TaskRunControlMessage`
3. 本地 Codex / Claude 先打通：
  - stop
  - interrupt
  - restart with injected user message
4. 前端 task room 加：
  - 排队发送
  - 立即介入
  - 停止运行

## 相关文档建议阅读顺序
1. `docs/14_ACPX_TASK_RUNNER_PLAN.md`
2. `docs/15_ACPX_TASK_RUNNER_HANDOVER.md`
3. `docs/16_ACPX_INTERACTIVE_RUN_CONTROL_PLAN.md`
