# 15 ACPX Task Runner Handover

## 当前阶段
- ACPX 已经有第一版任务创建入口。
- ACPX 已经能创建 `TaskRun`、`TaskRunParticipant`、`TaskRunEvent`，并在 `/tasks/[id]/chat` 展示 latest run 的执行事件。
- 本地 Codex / Claude 与远端 Gateway OpenClaw 已经接入同一条 ACPX 运行链路。
- 当前实现已经不是“纯 demo 静态页”，但还远远不是一个可交互、可回溯、可协同的真实 task room。

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
- 60 秒足够做极短问答，但通常不够做：
  - 阅读仓库
  - 修改文件
  - 跑测试
  - 输出总结

建议：
- 先把本地 Codex timeout 提高到更现实的值，例如 10 分钟或按任务类型配置。

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
1. 先把 Codex timeout 调整到真实可用水平
- 否则“本地 implementer”会持续成为假失败源。

2. 给 task 增加 run history，而不是只看 latest run
- 先解决“看不见上一轮发生了什么”。

3. 把 `/tasks/[id]/chat` 从“console 页面”升级为“task room”
- 至少加：
  - 用户输入框
  - 用户消息流
  - runner/system 消息
  - run console 分区

4. 定义用户如何介入运行中的任务
- 可以先不做真正中断式控制。
- 但至少要支持：
  - 用户补充说明
  - 用户发 follow-up
  - 用户触发新一轮 run，并保留前一轮上下文

5. 重新定义跨 Gateway 共享代码库语义
- 如果后续要支持多 Gateway 协同编码，必须补：
  - shared repo/ref contract
  - per-gateway workspace mapping

## 当前不应再自我误导的点
- 现在的 `/tasks/[id]/chat` 不是完整 chat。
- 现在的多 participant ACPX 不是完整多人协作 room。
- 现在的跨 Gateway 不是共享代码工作区。
- 现在的 latest run 页面不是历史回放界面。

## 新会话建议先读
1. `docs/14_ACPX_TASK_RUNNER_PLAN.md`
2. `docs/15_ACPX_TASK_RUNNER_HANDOVER.md`
