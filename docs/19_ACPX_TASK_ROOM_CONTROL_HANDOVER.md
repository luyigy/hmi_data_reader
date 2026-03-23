# 19 ACPX Task Room Control Handover

## 日期
2026-03-23

## 目的
这份 handover 用于在 ACPX task room / run control 工作继续推进前，明确当前实现的真实状态，避免后续会话继续把“过渡实现”误当成“已完成能力”。

它重点回答四个问题：
- 现在到底已经做成了什么
- 哪些只是第一版过渡实现
- 用户最新测试暴露了什么真实问题
- 下一会话应该优先做什么

## 当前代码状态

### 已提交的关键提交
- `73c9adf`
  - `Add ACPX task room control foundation`
- `b9c150e`
  - `Fix ACPX direct codex workspace access`

### 当前工作区未提交改动
当前还有未提交修改，主要在：
- `src/lib/acpx/runner.ts`
- `src/app/api/tasks/[id]/control/route.ts`
- `src/app/tasks/[id]/chat/page.tsx`
- `prisma/dev.db`

这些未提交修改的目标是：
- 收紧 `waiting_for_input` / request card 的显示条件
- 减少把普通输出误判成 permission request
- 让完成态 run 不再继续显示旧 request 卡片

## 已真实完成的部分

### 1. ACPX session / run / control 基础模型已落地
当前已经有：
- `TaskSession`
- `TaskRun`
- `TaskRunParticipant`
- `TaskRunEvent`
- `TaskRunControlMessage`

并且 run API 已能返回：
- `taskSessionId`
- `controlState`
- `activityState`
- participant capability flags

### 2. `/tasks/[id]/chat` 已经不再只是 latest run console
当前页面已具备第一版 task room 形态：
- task room 消息流
- run history
- selected run console
- participant outcomes
- room 输入框
- run control 按钮

### 3. direct local Codex 可写工作区问题已经定位并修正
关键结论：
- `codex exec` 必须使用：
  - `codex exec --sandbox workspace-write ...`
- 之前参数位置不对时，虽然看起来传了可写 sandbox，实际仍会落到只读语义

这个问题已经通过真实写文件测试验证过：
- Codex 可在目标工作区创建文件

### 4. 第一版本地 run control 已经可用
当前已支持：
- `queue_message`
- `interrupt_now`
- `stop_run`

但要注意：
- 这主要对本地 harness 有意义
- 对远端 gateway / OpenClaw 目前仍以“记录控制请求”为主

## 只做到“过渡实现”的部分

### 1. “开始运行 / 重新开始”不是原地继续同一个 harness session
当前点击“开始运行”时：
- 会复用同一个 `TaskSession`
- 会新建一个新的 `TaskRun`
- 会带上 task room 中已有上下文

但不会：
- 接管上一个 run 的原生 CLI session
- 把用户点击结果原地送回同一个 direct harness 会话

换句话说：
- 当前是“基于上下文的新 run”
- 不是“原地 continuation”

### 2. request card / waiting_for_input 仍然只是第一版启发式检测
当前实现里，runner 会尝试从 stdout / stderr 文本中识别：
- `permission_request`
- `input_request`
- `choice_request`
- `workspace_issue`

但这还不是结构化协议，也不是 direct harness 的真实交互事件流。

所以当前系统仍可能：
- 把普通说明误判成 request
- 把启动信息误当成 permission-like 文本
- 在 run 已完成后仍遗留旧 request UI

### 3. allow / deny / explain 按钮还不是真正的 harness approval UI
这三个按钮目前本质上仍然是：
- 生成模板化用户消息
- 走 ACPX control flow
- 倾向于“中断 + 新 run”

它们不是：
- direct codex / claude code 原生会话中的真实批准按钮
- 也不是 current session 内的结构化回应

所以不能把这块当成“真实 permission approval flow”。

## 用户最新测试确认的问题

### 1. permission-like UI 仍会误导
用户明确反馈：
- 按钮可以点击
- 但内容不变
- 无法确认这是否真的是 harness 的权限申请
- 看起来更像是平台做了三个按钮让人点，而不是真正的 allow/submit 交互

这个判断是正确的。

### 2. `waiting_for_input` 会卡住或残留
用户测试时出现：
- run 状态停在 `waiting_for_input`
- 或 run 已完成，但页面还残留 request card

说明当前状态恢复与 UI 清理逻辑还不够可靠。

### 3. task room 还不能 `@某个 participant` 或 `@all`
当前消息只能自然作用于：
- 整个 task room

还不能正式表达：
- `@codex`
- `@claude`
- `@reviewer`
- `@all`

所以 participant-targeted message 还未实现。

### 4. 远端 harness 没有足够清晰的 activity / liveness 提示
用户在本地 Codex handoff 到远端 Claude 后，看到：
- `participant_started reviewer ...`
- 之后没有新的输出

用户无法判断：
- reviewer 还活着，只是远端当前无流式输出
- 还是 reviewer 已经卡死

当前平台也确实还不能可靠区分这两种情况。

### 5. direct harness 会输出环境限制说明，但平台还没把它们升级成真正的人机交互协议
示例：
- “当前沙箱无法访问宿主机本地端口，所以我不能在这里直接验证 `7000/8000/8003` 的在线推理结果。”

这类内容当前更像：
- agent 普通说明

而不是：
- 平台已捕获的结构化权限/输入请求

## 当前不应误判为“已完成”的点
- 现在还没有真正的 harness-native permission approval flow
- 现在还没有 direct session 内原地继续
- 现在还没有 participant-targeted message / mention
- 现在还没有远端 harness 的可靠 liveness / stalled / dead 区分
- timeout 仍然没有完全退位为真正的 watchdog product model

## 下一会话建议优先级

### P0. 先完成“去伪存真”的轻修
目标：
- 收紧 request detection
- 只在 `waiting_for_input` 且元数据匹配时显示 request card
- run 结束后清理旧 request UI
- `workspace_issue` 只显示成问题提示，不再伪装成可批准请求

这是最应该先收尾的一步，因为当前 UI 已经对用户造成误导。

### P1. 做 participant-targeted message / mention
最小目标：
- message target 支持：
  - `task`
  - `participant`
  - `all`
- UI 至少允许：
  - 发给 implementer
  - 发给 reviewer
  - 发给全部

### P2. 给远端 harness 明确“无流式输出但仍在运行”的状态提示
最小目标：
- 不再让用户把“无输出”默认理解成“挂了”
- UI 明确区分：
  - 本地流式运行
  - 远端 final-only 运行
  - 长时间无活动

### P3. 再回到真实 session continuation / approval flow
真正目标应是：
- 用户响应 direct harness 的真实输入/权限请求
- 响应被送回当前 harness session
- 尽量避免“中断 + 新 run”伪装成 continuation

## 建议下个会话先读
1. `docs/15_ACPX_TASK_RUNNER_HANDOVER.md`
2. `docs/16_ACPX_INTERACTIVE_RUN_CONTROL_PLAN.md`
3. `docs/18_ACPX_NEXT_RUN_EXECUTION_ORDER.md`
4. `docs/19_ACPX_TASK_ROOM_CONTROL_HANDOVER.md`
