---
doc_type: HANDOVER
doc_status: paused
next_action: next_slice
plan: 253_PLAN_20260726_审批后新Session与Prompt全链路验收.md
slice: S01
plan_progress: in_progress
---

# HANDOVER · 审批后新 Session 链路与未提交改动交接

## 当前目标

继续执行 `253_PLAN_20260726_审批后新Session与Prompt全链路验收.md`，把审批后的行为
收敛为：

1. 一个全局 Scheduled Job Runner 服务监控多个项目；
2. watcher 按 `(projectId, jobId)` 隔离，项目级 `disable` 同时停止未来调度和当前轮；
3. workflow 每个 event key 只完成一次 Session reset、飞书 Prompt、Live Room Prompt
   和 agent 排队；
4. 不重启其他群的 watcher，不把 feature 逻辑继续堆进历史长文件。

## 已完成但尚未提交

- `disable workflow-watcher` 已改为先写禁用状态，再复用项目级 `stopScheduledJob`，
  最多等待 5 秒确认该 `(projectId, jobId)` 没有 running run。
- workflow dispatch 增加数据库幂等状态，按 `(projectId, jobId,eventKey)` 唯一：
  `prepared → session_reset → feishu_posted → prompt_posted → reply_queued`。
- 新 Session reset 会把 `workflowEventKey` 记录到 `TaskSession.metadata`，失败重试时可
  识别已经完成的 reset。
- Prompt 先发送到绑定飞书会话，再镜像为 Live Room 用户消息；agent reply 改为只排队，
  watcher 不等待 Agent 完整执行。
- 测试群 `workflow-test` 已加入 `config/projects.yaml`；Runner 每 15 秒重新读配置，
  单纯新增项目配置不需要重启服务。
- 已增加 migration：
  `prisma/migrations/20260726173000_add_workflow_dispatch/migration.sql`。

## `/ap new-session` 的真实语义

- 当前 `HEAD` 已让 new-session 对目标成员调用 `stop_run`；本地注册的旧 run 会收到
  `SIGKILL`，这比原来的 `interrupt_now` / `SIGINT` 更强。
- 命令只等待“停止请求已投递”，**不等待旧 OS PID 确认退出**。因此不能把命令回执理解
  为旧进程退出屏障。
- 单成员模式随后同步 `await executeAcpxTaskRun(...)`，要等新 bootstrap run 完成才返回；
  这通常是“new-session 半天不结束”的主要来源，不等于旧 run 仍在停止。
- `new-session --all` 不立即执行 bootstrap，只写入每个 participant 的 Prompt，等下一条
  真实用户指令再启动，因此会快速返回。
- 当前运行中的 Next 服务 PID 为 `385443`，启动于 `2026-07-26 13:15:19`；Scheduled Job
  Runner PID 为 `1374125`，启动于 `2026-07-26 17:00:38`。在部署前必须核对目标服务实际
  加载的 commit，不能仅凭工作区源码断言运行态行为。

## Feature 自包含边界

- 新增 workflow 编排主体留在独立 feature 文件 `src/lib/feishu-workflow.ts`，当前 129 行。
- `src/lib/live-room-delivery.ts` 只增加 `waitForCompletion` 可选参数并向既有队列传递；
  `src/lib/scheduled-jobs/runner.ts` 只增加项目级停止等待函数。
- 不再新建 service、runner、dispatcher 抽象，也不为了拆 129 行文件继续拆文件。
- 若后续需要优化手工 `/ap new-session` 的回执速度，优先复用现有“只排队、不等待”
  能力；先做 GitNexus impact 和一条最小回归，禁止复制 workflow dispatch 状态机。

## 工作区边界

当前工作区包含 13 个已修改文件和 1 个未跟踪 migration，均视为前序工作，不得 reset
或覆盖：

- `CLAUDE.md`
- `config/projects.yaml`
- `package.json`
- `prisma/schema.prisma`
- `prisma/migrations/20260726173000_add_workflow_dispatch/migration.sql`
- `src/lib/feishu-new-session.ts`
- `src/lib/feishu-scheduled-jobs.ts`
- `src/lib/feishu-workflow.ts`
- `src/lib/live-room-delivery.ts`
- `src/lib/live-room-process-registry.ts`
- `src/lib/scheduled-jobs/runner.ts`
- `src/lib/scheduled-jobs/workflow-watcher.ts`
- `tests/live-room-process-registry.test.ts`
- `tests/scheduled-job-runner.test.ts`

前一 Session 已报告 Prisma generate、scheduled-job、queue、workflow-watcher 回归及
`tsc --noEmit` 通过；新 Session 必须自行复跑，不能只相信交接结论。

本 Session 已按仓库要求运行
`detect_changes(scope=compare, base_ref=master)`：结果为 **CRITICAL**，原因是当前分支
相对 master 累积 146 个文件、688 个 symbol 的历史差异，影响 197 条流程。该结果不能
证明本批 14 个工作区文件可安全提交；提交前必须再按精确 staged/unstaged 范围审计。

## 下一步

1. 先读本 HANDOVER、253 PLAN、workflow contract 和完整工作区 diff。
2. 用 GitNexus `detect_changes(scope=compare, base_ref=master)` 复核已有改动的真实范围；
   HIGH/CRITICAL 必须先报告，不能直接提交。
3. 运行 Prisma generate、migration 状态检查、相关最小测试、`tsc --noEmit` 和
   `git diff --check`。
4. 检查数据库 migration 是否尚未应用；应用 migration、提交、重启或部署都属于独立
   状态变更，未获当前用户明确授权前不要执行。
5. 完成后用真实测试群验收：项目级 disable 不影响其他项目；批准事件只 reset 一次、
   Prompt 只发送一次、reply 只排队一次。
6. 不要把手工 `/ap new-session` 当作 workflow 验收的替代路径。

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/254_HANDOVER_20260726_审批后新Session链路与未提交改动交接.md`、
`docs/253_PLAN_20260726_审批后新Session与Prompt全链路验收.md` 和
`docs/224_PLAN_20260725_通用项目定时任务平台.md`，并遵循
`docs/workflow/workflow-contract.yaml`，继续执行 S02。保留全部既有未提交改动，不得 reset。先核对
完整 diff、GitNexus detect_changes、migration 状态和运行服务所加载的 commit；然后复跑
Prisma generate、scheduled-job、live-room queue、workflow-watcher、TypeScript 与
diff-check 验证。遵循 feature 自包含：workflow 主体留在 `feishu-workflow.ts`，共享长文件
只保留最小参数透传，不新增 service 或抽象。未经用户明确授权不得应用 migration、提交、
重启服务或触发真实审批；若获授权，再按 253 PLAN 验收项目级原子停用、dispatch 幂等、
飞书 Prompt、Live Room 排队和无重复 Session。
<!-- WORKFLOW_PROMPT_END -->
