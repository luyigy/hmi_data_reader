---
doc_type: PLAN
doc_status: ready
next_action: start_first_slice
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · 定时任务与 Workflow 重启恢复闭环

## 目标

基于现有 `ScheduledJobState.cursorJson + WorkflowDispatch.state + PostgreSQL advisory lock + 幂等键`
补齐进程重启后的启动收口、周期核对和审批轮次恢复，使孤儿 Run、遗留 request、失活 TaskRun 与过期
Workflow 审批都能回到明确状态。

本 PLAN 只完成 P0 恢复闭环和故障注入验证；不实现 P1 状态卡片，不新增 lease、heartbeat、outbox 或第二套
工作流引擎。

## 已确认事实

- `startScheduledJobRunner` 是 scheduled-job 常驻循环入口，当前启动后直接执行
  `runRequestedJobs` 和 `runDueJobs`，没有 boot reconcile。
- `ScheduledJobRun` 先写入 `running`，再进入 advisory transaction；进程退出后没有 owner/lease
  可供周期任务安全判断，只能在新进程启动边界收口旧 `running` 记录。
- `ScheduledJobRequest` 从 `pending` claim 为 `processing` 后异步执行；进程退出会遗留
  `processing`。不能简单退回 `pending`，因为对应 `manual:<project>:<job>:<request>` run 的唯一幂等键
  可能已经存在。
- `reconcileTaskRunLiveness(taskId)` 已能按 PID 探活并收口本地失活 TaskRun，但没有无参数全库入口；
  boot/周期核对必须先枚举存在活跃 Run 的 taskId。
- `FeishuAdminApproval` 已有 `status + expiresAt` 索引，过期 pending 审批目前只在点击时被拒绝，没有统一
  sweeper。
- Workflow PLAN 审批保存在 `ScheduledJobState.cursorJson.pending`；当前卡片 uuid 由
  `pending.key + plan_review` 派生，同一事件重发会得到相同 uuid，不能用来创建新的过期审批轮次。
- `WorkflowDispatch.state` 已记录 `prepared → session_reset → feishu_posted → prompt_posted →
  reply_queued`，应继续作为外部投递恢复的事实源。
- 当前工作树已有用户对 `workflow-watcher.ts`、Feishu、ACPX 和测试的未提交修改；每个 Slice 必须先核对并
  保留这些改动，只精确提交本 PLAN 的文件。
- 开工前 `npm run check:long-files` 通过，没有达到 1000 行阻断阈值的源码。

## 边界与裁决

### 包含

- runner 启动时一次性收口启动时间之前遗留的 `ScheduledJobRun running` 和
  `ScheduledJobRequest processing`；
- 启动及周期枚举活跃 taskId，复用现有 PID liveness reconciliation；
- 过期 `FeishuAdminApproval pending` 清理；
- Workflow 审批过期后的新 attempt、新 expiry 和新幂等键；
- 围绕 60 秒 job timeout、审批卡发送和 `WorkflowDispatch` checkpoint 的故障注入测试；
- 恢复结果的最小日志/既有通知，不新增状态卡片产品面。

### 不包含

- 不增加 runner owner、lease、heartbeat、Pod 探针或跨机器存活协议；
- 不增加 outbox、事件总线、通用 reconciliation 框架或新数据库表；
- 不在周期循环中仅凭 `startedAt` 判死可能属于其他 runner 的 `ScheduledJobRun`；
- 不自动移动 workflow cursor、强制对齐 HEAD、忽略 Git 历史分叉或猜测外部副作用；
- 不恢复停机期间已经丢失的卡片点击；旧轮次失效后只创建可重新操作的新轮次；
- 不实现 P1 Workflow 状态卡片和高风险人工恢复按钮；
- 不重启服务、不发送真实 Feishu 消息，除非用户在最终验收时另行明确授权。

## S01：启动收口与周期核对

先对本 Slice 实际修改的每个 function/class/method 运行 GitNexus upstream impact；HIGH 或 CRITICAL
必须先报告，再开始编辑。沿用现有 scheduled-job runner，增加最小 boot/periodic reconciliation：

1. 在进入常驻循环前记录本次启动边界，并只收口 `startedAt < 启动边界` 的
   `ScheduledJobRun status=running` 为 `failed`，写入 `finishedAt` 与稳定错误码/说明
   `process_restart`。
2. 将启动边界前遗留的 `ScheduledJobRequest status=processing` 收口为 `failed/process_restart`；
   不退回 `pending`，不自动重放已有唯一幂等键的 run。
3. 枚举拥有 `running` 或 `waiting_for_input` TaskRun 的 distinct taskId，逐个调用现有
   `reconcileTaskRunLiveness(taskId)`；启动时执行一次，并在 runner 周期中低频复用同一函数。
4. 将 `expiresAt <= now` 的 `FeishuAdminApproval status=pending` 原子更新为 `expired`；已进入
   `processing` 或终态的审批不猜测、不覆盖。
5. boot reconcile 必须可重复执行；第二次运行更新数为 0，不能改写已完成记录。

完成标准：

- 重启前遗留 run/request 被明确收口且不会重放；
- 当前进程启动后新建的 run 不会被 boot reconcile 误判；
- 失活 TaskRun 复用既有终态和事件语义，存活进程不受影响；
- 过期 admin approval 只从 pending 进入 expired；
- 一个最小聚焦测试覆盖 boot 边界、幂等重跑、request 不回 pending、PID 存活/失活和审批过期；
- 相关 TypeScript、ESLint、聚焦测试、`npm run check:long-files`、`git diff --check` 通过；
- 提交前运行 GitNexus `detect_changes({scope: "compare", base_ref: "master"})`，只提交 S01 实现、测试和
  S01 HANDOVER。

## S02：Workflow 审批轮次与投递 checkpoint 恢复

在 cursor 既有 `pending` 结构中增加最小 `reviewAttempt`，不做 schema migration：

1. 原卡发送结果未知且轮次未过期时，继续使用同一 attempt 幂等恢复，避免重复卡。
2. `reviewExpiresAt <= now` 时把旧卡更新为失效（更新失败只记录，不阻断收口），关闭旧 review，
   `reviewAttempt + 1`、生成新 expiry，并用包含 attempt 的派生幂等键发送新卡。
3. 旧 `reviewMessageId` 的回调必须返回 stale；只有当前 attempt、当前 message id 和有效期内的决定
   可以改变 review state。
4. 继续以 `WorkflowDispatch.state` 判断 session reset、Feishu prompt 和 reply queue 是否已经发生；
   能由数据库证明的阶段自动续跑，无法证明副作用的阶段转 `blocked`，不得猜测补发。
5. 对 scheduled job 默认 60 秒 timeout 边界做故障注入，覆盖卡片发送前后、cursor 保存前后，以及
   `prepared/session_reset/feishu_posted/prompt_posted/reply_queued` 各 checkpoint；成功副作用不得重复，
   未完成状态必须可由下一轮收口或明确阻断。

完成标准：

- 过期审批自动产生新的可操作轮次，uuid 与旧轮次不同；
- 旧卡、重复回调和并发回调不能批准新轮次或启动两个 Session；
- 未过期卡的崩溃重试保持原幂等键，不产生重复卡；
- `prompt_posted` 之后不因 timeout 重发 prompt；
- Git ref 历史重写、审批冲突和无法确认的外部副作用仍明确 `blocked`；
- 聚焦测试、workflow watcher/dispatch/approval 回归、TypeScript、ESLint、long-file guard、
  `git diff --check` 和 GitNexus `detect_changes` 通过；
- 只提交 S02 实现、测试和 S02 HANDOVER。

## S03：恢复链路集成验证与终态交接

在隔离数据库和 fake Feishu sender 中验证两个重启场景：

1. runner 在 job/request/TaskRun 执行中退出后重启；
2. PLAN 审批卡发送前后或 workflow dispatch checkpoint 中退出后重启。

同时覆盖重复启动、重复 watcher、并发审批、60 秒 timeout、Git 历史分叉、服务停止和已有用户改动保护。
验证恢复日志能说明收口数量与错误原因；不为此新增状态卡片。

完成标准：

- 自动恢复项全部回到确定状态，人工项全部停在 `blocked`；
- 没有重复 Session、重复 prompt、重复审批副作用或永久 `running/processing/review`；
- 相关聚焦与回归测试、TypeScript、ESLint、`npm run check:long-files`、`git diff --check` 和
  GitNexus `detect_changes({scope: "compare", base_ref: "master"})` 通过；
- 创建 `plan_progress: complete`、`next_action: await_acceptance` 的 S03 HANDOVER 后停止；
- 真实服务重启和真实 Feishu 验收未获用户授权时明确记录为未执行，不伪称通过。

## 风险与控制

- **共享核心入口：** scheduled-job runner、ACPX liveness、workflow watcher 和 Feishu 回调影响多个入口；
  每个 Slice 只修改所需 symbol，按仓库规则先做 upstream impact，HIGH/CRITICAL 先报告。
- **多 runner 误判：** 当前没有 owner/lease；旧 `ScheduledJobRun` 只在 boot 时按启动边界收口，周期循环
  不扫描并判死其他 runner 的记录。
- **外部副作用不透明：** 仅对数据库能证明的 checkpoint 自动恢复；证明不了时宁可 blocked，不自动重发。
- **审批幂等：** attempt 是旧轮次与新轮次的唯一差异，不改变 eventKey、文档 blob 或审批业务决定。
- **事务超时：** 故障注入先证明边界；若修复需要改变 advisory lock 或 transaction 范围，必须重新运行
  impact 并在 HIGH/CRITICAL 时暂停报告，不顺手扩成锁框架。
- **工作区保护：** 精确 `git add` 本 Slice 文件，不清理、覆盖或提交开工前已有改动。
- **长文件保护：** 已有源码不得增长到 800 行预警线；新增恢复职责优先放入单一小模块并由 runner 调用。

## 计划级完成条件

- 启动前遗留的 scheduled run/request 和本地 TaskRun 能确定收口；
- 周期核对复用 PID 探活与审批 expiry，不依赖新 heartbeat；
- Workflow 过期审批能建立新轮次，未过期重试和 dispatch 恢复保持幂等；
- 两类进程重启和 60 秒 timeout 故障注入均无重复副作用；
- 无法证明状态、Git 历史重写和审批冲突保持 blocked；
- P1 状态卡片与 P2 lease/outbox 明确留在本 PLAN 之外。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/319_PLAN_20260730_定时任务与Workflow重启恢复闭环.md` 的 S01：只实现 scheduled-job runner
启动收口与周期核对。先读取 `AGENTS.md`、`docs/workflow/workflow-contract.yaml`、本 PLAN、当前最新有效
HANDOVER，以及 scheduled-job runner、ACPX liveness、Feishu admin approval 的现有实现；保留开工前
工作区所有用户改动。对实际修改的每个 function/class/method 先运行 GitNexus upstream impact，
HIGH/CRITICAL 必须先报告。不得开始 S02/S03，不修改 Workflow 审批 attempt，不新增 heartbeat、lease、
outbox、状态卡片或数据库表，不重启服务或发送真实 Feishu 消息。完成聚焦测试、相关回归、TypeScript、
ESLint、`npm run check:long-files`、`git diff --check` 和 GitNexus
`detect_changes({scope: "compare", base_ref: "master"})` 后精确提交，并创建
`plan_progress: in_progress`、`next_action: next_slice` 的 S01 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
