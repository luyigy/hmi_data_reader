# 15 ACPX Task Runner Handover

## 当前阶段
- ACPX 已经有第一版任务创建入口。
- ACPX 已经能创建 `TaskRun`、`TaskRunParticipant`、`TaskRunEvent`，并在 `/tasks/[id]/chat` 展示 latest run 的执行事件。
- 本地 Codex / Claude 与远端 Gateway OpenClaw 已经接入同一条 ACPX 运行链路。
- 当前实现已经不是“纯 demo 静态页”，但还远远不是一个可交互、可回溯、可协同的真实 task room。
- 最新一轮已引入：
  - `TaskSession`
  - `TaskRunControlMessage`
  - run activity / control state
  - task room 中的第一版：
    - queued message
    - immediate intervention
    - emergency stop
  - 本地 harness 进程注册与中断/停止信号发送

## 2026-03-23 晚间补充交接

### 本轮已经真正落地的内容
- `/tasks/[id]/chat` 已不再只是只读 console：
  - 左侧 task room 可发送排队消息
  - 可对当前 run 发起：
    - `queue_message`
    - `interrupt_now`
    - `stop_run`
- backend 已新增：
  - `TaskSession`
  - `TaskRunControlMessage`
  - `HarnessCapability`
  - `RunActivityState`
  - `WatchdogConfig`
- ACPX run API 现在会返回更多状态字段：
  - `taskSessionId`
  - `controlState`
  - `activityState`
  - participant capability flags
- 本地 `codex` / `claude` 已有第一版进程注册机制：
  - UI 发出立即介入或停止后，后端会尝试向本地 CLI 子进程发送中断/停止信号

### 本轮联调后确认的新事实

#### 1. 现在的“resume / 再跑一轮”仍然不是原地恢复同一 harness session
- 当前行为本质上仍然是：
  - 创建新的 `TaskRun`
  - 复用 task room 上下文
- 还不是：
  - 在同一个 direct harness session 内继续
  - mid-run 直接向 CLI 会话注入新输入

#### 2. timeout 不能再作为硬编码产品行为
- 这轮已经把本地 direct harness 默认 runtime 从 60 秒提升到更现实的量级。
- 但这只是临时缓解，不是最终解法。
- 已确认后续必须继续推进：
  - watchdog contract 真正接管
  - UI 可理解的 runtime / inactivity 策略
  - 不同 harness 的差异化策略

#### 3. direct harness 当前仍可能处于只读/不可写环境
- 从 Codex 输出里已明确出现：
  - “当前会话是只读环境，无法修改仓库”
- 这说明当前平台虽然能拉起 direct harness，但没有稳定保证：
  - 可写工作区
  - 正确的权限模式
  - direct harness 对本地 repo 的真实写权限

这不是小问题，而是阻断 ACPX 成为真实 coding workspace 的关键缺口。

如果 direct harness 只能读不能写，则 ACPX 当前只能稳定承担：
- 分析
- 计划
- 总结
- review 意见

而不能稳定承担：
- 实际改代码
- 运行会产生修改的修复任务
- “立即介入后继续编码”这种闭环

#### 4. direct harness 的权限确认 / 交互输入不能只留在服务器侧 CLI
- 当前直连 `codex` / `claude code` 这类 harness 时，会自然出现：
  - 权限确认
  - 选项选择
  - 需要用户补充输入
- 平台不能把这些交互吞掉，或让它们只存在于服务器终端里。
- 用户必须能在 task room 中看到并响应这类请求。

这个能力本质上应被纳入 ACPX control model，而不应被视为“CLI 私有细节”。

建议后续显式引入：
- `needs_user_input`
- `permission_request`
- `choice_request`
- `input_request`

以及对应的 room UI：
- 请求卡片
- 用户确认 / 拒绝
- 用户选项提交
- 继续执行

#### 5. Next API route 需要显式保持 dynamic
- 本轮调试中出现过：
  - `/api/tasks/[id]/runs` 被 Next 误走到 static path 相关逻辑
- 当前已通过显式 dynamic 配置做临时修正。
- 后续仍需继续留意 ACPX 相关 API 不应被静态化。

## 本轮联调后已经确认的事实

### 1. ACPX 任务现在可以创建并启动
- 任务创建接口已支持：
  - `executionMode: acpx`
  - `acpxParticipants`
  - `workingDirectory`
- 创建时如果 Prisma Client 过旧，会直接在前端暴露错误信息。

### 2. 本地 Codex 已经能被真正拉起
- 之前本地 Codex 会因为工作目录不是 trusted git repo 而立即失败。
- 当前已改为默认带：
  - `codex exec --skip-git-repo-check`
- 这解决了“目录信任检查直接阻塞 ACPX”的问题。

### 3. 本地 Codex 当前新的主要问题是 timeout
- 已确认本地 Codex 现在会真正启动。
- 但当前 runner 默认给 Codex 的超时时间还是：
  - `60000ms`
- 对真实编码任务来说，这个超时时间太短，60 秒内失败是高概率事件。

### 4. `/tasks/[id]/chat` 现在只展示 latest run
- 页面数据来自：
  - `GET /api/tasks/[id]/runs/latest`
- 这意味着：
  - 离开页面后再回来，只会看到最新一轮 run
  - 不支持浏览某个 task 的 run 历史列表
  - 不支持在多个 run 之间切换
- 结果是用户主观感受像“历史被覆盖了”，即使数据库里老 run 还在。

### 5. 当前“聊天室”本质上不是聊天室
- 现在的 `/tasks/[id]/chat` 更像：
  - latest run console
  - append-only event list
- 它缺少真正 chat room 的关键能力：
  - 用户发消息
  - 用户追问 / 纠偏
  - 用户在运行中补充上下文
  - 用户要求某个 participant 重新聚焦
  - 用户对阶段结果进行确认后再继续

### 6. 当前 ACPX 是“初始描述驱动”，不是交互式任务协作
- 现在 ACPX participant 拿到的核心输入还是：
  - task description
  - previous participant summaries
- 一旦 run 开始，用户几乎没有正式入口介入执行过程。
- 这意味着当前 ACPX 更接近：
  - fire-and-forget orchestration
- 而不是：
  - human-in-the-loop coding workspace

### 7. 跨 Gateway 当前并不共享同一份代码工作区
- 本地 participant 使用的是平台本地 `workingDirectory`。
- 远端 Gateway participant 当前不会自动挂载、同步或 checkout 这份代码目录。
- 因此跨 Gateway 当前共享的是：
  - 初始任务描述
  - 前序摘要
- 不是共享文件系统，也不是共享 repo checkout。

## 当前体验上的核心问题

### 问题 A: Codex timeout 不适合真实编码任务
- 旧的 60 秒足够做极短问答，但通常不够做：
  - 阅读仓库
  - 修改文件
  - 跑测试
  - 输出总结

建议：
- 已临时把本地 direct harness runtime 提高到更现实的默认值。
- 但后续不要把“再调大一些 timeout”继续当成最终方案。
- 应该尽快把：
  - `watchdogConfig`
  - inactivity warning / fail
  - per-harness runtime strategy
  真正接入 runner 与 UI。

### 问题 B: task chat 只有日志，没有用户参与入口
- 当前用户无法在 run 进行中对 ACPX 说：
  - “不要改这个目录”
  - “先只分析，不要写代码”
  - “Windows reviewer 先等 implementer 的结果”
  - “改成用另一个模型/网关”

建议：
- 下一阶段不要只优化 console。
- 应该把 `/tasks/[id]/chat` 重新定义成：
  - task room
- task room 至少要同时包含：
  - run timeline / console
  - user message input
  - system / runner / participant message stream
  - 后续 action controls

### 问题 C: latest run 设计让历史 run 不可见
- 这会让用户误以为“离开页面后历史没了”。
- 也不利于排查：
  - 第一次 run 为什么失败
  - 第二次 run 修了什么
  - 第三次 run 又为什么超时

建议：
- task 页面需要新增：
  - run list
  - run 切换
  - latest run 只是默认选中项，不应是唯一可见项

### 问题 D: 跨 Gateway 角色协作语义还不完整
- 当前 reviewer / tester / planner 主要吃到的是摘要，不是共享工作树。
- 这对于：
  - review summary
  - research
  - plan
- 还算可用。
- 但对于：
  - 真正 review 改动
  - 跑测试
  - 修改同一代码库
- 语义不够。

建议：
- 后续明确选择以下一种仓库共享策略，不要继续依赖“平台本地工作目录”这个单点概念：
  - 每个 Gateway 各自 checkout 同一 repo/ref
  - 共享网络工作区
  - 显式 artifact sync / patch handoff

### 问题 E: direct harness 还没有稳定可写工作区保证
- 当前 direct `codex` / `claude` 的关键风险不是“能不能拉起”，而是：
  - 拉起后是否真的可写
  - 是否能修改当前仓库
  - 是否在正确权限模式下运行
- 如果不解决这个问题，ACPX 看起来像 coding workspace，实际却只能做只读分析。

建议：
- 优先确认并固定 direct harness 的工作区/权限 contract：
  - working directory 映射
  - writable sandbox / approval mode
  - repo trust / permission mode
  - 修改后的文件可见性

### 问题 F: 用户还无法处理 harness 主动发起的权限 / 输入请求
- 当前 task room 支持的是：
  - 用户主动发消息
  - 用户主动中断 / 停止
- 但还不支持：
  - harness 主动请求用户确认
  - harness 主动让用户在几个选项中选择
  - harness 等待用户输入再继续

建议：
- 下一阶段把“用户响应 harness 请求”视为 first-class control flow，而不是后补 UI。
- `timeout` 与 `waiting_for_input` 必须彻底分开。

## 当前代码层面的关键文件
- `src/app/api/tasks/route.ts`
- `src/app/api/tasks/[id]/execute/route.ts`
- `src/app/api/tasks/[id]/logs/route.ts`
- `src/app/api/tasks/[id]/runs/latest/route.ts`
- `src/app/tasks/[id]/chat/page.tsx`
- `src/components/tasks/TaskForm.tsx`
- `src/lib/acpx/runner.ts`
- `src/lib/acpx/types.ts`
- `src/lib/acpx/event-bus.ts`
- `src/lib/real-agents/codex-agent.ts`
- `src/lib/real-agents/claude-agent.ts`

## 建议的下一步优先级
1. 先解决 direct harness 的可写环境问题
- 这是当前 ACPX 成为真实 coding workspace 的最大 blocker。

2. 定义并接入 harness 主动请求用户输入/确认的机制
- 让 task room 不只是“用户主动发消息”，而是真正的人机交互面板。

3. 把 timeout 临时值继续退位为 watchdog contract
- 不再让“硬编码超时”主导产品语义。

4. 做“立即介入后自动带上下文重启下一轮 run”
- 让 immediate intervention 更接近真实 resume，而不是用户手动再点一次开始运行。

5. 再继续深化跨 Gateway 共享代码库语义
- 补 shared repo/ref / workspace contract。

## 当前不应再自我误导的点
- 现在的 `/tasks/[id]/chat` 不是完整 chat。
- 现在的多 participant ACPX 不是完整多人协作 room。
- 现在的跨 Gateway 不是共享代码工作区。
- 现在的 latest run 页面不是历史回放界面。

## 新会话建议先读
1. `docs/14_ACPX_TASK_RUNNER_PLAN.md`
2. `docs/15_ACPX_TASK_RUNNER_HANDOVER.md`
3. `docs/16_ACPX_INTERACTIVE_RUN_CONTROL_PLAN.md`
4. `docs/18_ACPX_NEXT_RUN_EXECUTION_ORDER.md`
