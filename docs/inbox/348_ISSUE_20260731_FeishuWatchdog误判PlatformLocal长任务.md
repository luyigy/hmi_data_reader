---
doc_type: ISSUE
doc_status: draft
next_action: none
---

# ISSUE · Feishu Watchdog 误判 Platform Local 长任务

## 状态

- 优先级：P1，建议在下一次 Live Room delivery 可靠性维护中修复。
- 当前处理：仅记录到 Git Inbox，不启动 workflow，不修改代码或运行时配置。
- 已知实例：2026-07-31 的 Feishu DM `08a216` / HMI Reader 房间 Kimi Code 长任务。

## 问题

Platform Local 对 Codex、Claude 和 Kimi Code 明确传入 `maxRuntimeMs: null`，允许长时间执行。
但 Feishu long-connection runtime 的 watchdog 仍把 `attemptedAt` 超过 12 分钟的所有
`running` delivery 直接改为 `failed`，不检查对应进程是否仍存活，也不终止进程。

当命中任意一条超时 delivery 时，watchdog 还会把所有 `busy` 的 Live Room 成员批量改为
`idle`，而不是只回收与失败 delivery 关联的成员和 Session。

## 现场证据

2026-07-31 的实例中：

- Kimi Code delivery 约 22:00 开始，22:15 被 watchdog 标记为 `failed`。
- 对应进程没有退出；22:19:50 后仍有模型响应，22:24 仍有网络数据活动。
- 房间成员已显示 `idle`，Session 仍残留 `busy`，后台子进程继续工作。
- 用户看到的是“任务失败/像是卡死”，但真实状态是长任务仍在执行且已脱离平台追踪。

## 根因

`src/lib/feishu-long-connection.ts` 中的 watchdog 仍基于“Claude 最长运行 10 分钟”的旧假设，
用固定 12 分钟墙钟时间判定 stale。这与
`src/lib/live-room-delivery-execution.ts` 对 Platform Local 三种 harness 的无执行上限配置直接冲突。

当前还混合了两个不同概念：

- 执行上限：允许任务总共运行多久，应由 execution backend / harness 配置决定。
- 失联超时：平台已无法确认进程存活或继续持有任务时，才应做异常回收。

12 分钟后由定时器发送的“仍在处理中”只是 UI 提示，不能单独当作子进程活性证据。

## 影响

- 长任务被误报失败，房间不再展示真实进度和终态。
- delivery、member、Session 和 OS 进程状态相互分裂，容易诱导用户重开任务。
- 重开后可能出现两个进程并发修改同一工作区。
- 全量 `busy -> idle` 回收可能误伤其他房间或成员的正常任务。
- 平台只改数据库不终止进程，无法保证失败后不再产生副作用。

## 建议的最小修复

1. watchdog 不再仅根据 `attemptedAt` 和固定墙钟时间判定 Platform Local delivery 失败。
2. 平台仍持有且能确认存活的对应进程时，watchdog 必须跳过该 delivery。
3. 真正失联时，只回收该 delivery 关联的 member、Session 和 TaskRun，不批量修改所有
   `busy` 成员。
4. 若 backend 配置了执行上限，应由执行器先终止对应进程，再统一落库为失败；不允许只改数据库。
5. 复用现有 process registry / liveness 能力，不新增第二套通用心跳或任务状态机。

单纯将 12 分钟改为 30 或 60 分钟只能缓解，不能修复判定语义和状态分裂。

## 验收标准

1. Platform Local Codex、Claude 和 Kimi Code 任务超过 12 分钟且进程仍存活时，delivery
   保持 `running`，成员和 Session 状态不被回收。
2. 进程退出、服务重启失去归属或活性确实不可确认时，对应 delivery 可进入明确失败终态。
3. 回收一条 stale delivery 不影响其他正常 `busy` 成员、Session 或并发任务。
4. 配置执行上限的任务超时后，进程已终止，delivery、TaskRun、Session 和 member 最终状态一致。
5. 增加聚焦回归测试，覆盖“活跃长任务”、“真实失联”、“多成员并发不误伤”和“执行上限统一终止”。

## 实施边界

- 后续实施前对 watchdog、delivery 终态落库、process registry 和 liveness 相关符号做
  GitNexus upstream impact；HIGH/CRITICAL 风险先报告。
- 若修复需要改动 `src/lib/feishu-long-connection.ts`，先遵守长文件守卫，必要时在同一提交中提取
  明确边界，不让已达阈值文件继续增长。
- 真实 Feishu 长任务、服务重启或共享数据库验收须在实施 PLAN 中明确授权；本 ISSUE 不执行这些操作。
- 实施时另建符合 `docs/workflow/workflow-contract.yaml` 的 PLAN，不直接将本 ISSUE 当作可执行文档。
