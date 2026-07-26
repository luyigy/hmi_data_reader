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

## 已完成、待提交与部署

- `disable workflow-watcher` 已改为先写禁用状态，再复用项目级 `stopScheduledJob`，
  最多等待 5 秒确认该 `(projectId, jobId)` 没有 running run。
- `stop workflow-watcher` 同样等待停止确认后才返回成功；watcher 的 `AbortSignal` 已贯穿
  workflow dispatch，并在 Session reset、飞书发送、Live Room 写入和 agent 排队前检查。
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
- Live Room 队列增加取消代次；`/ap new-session --all` 清理的旧排队闭包不会在当前运行
  结束后重新执行。

## `/ap new-session` 的真实语义

- 当前 `HEAD` 已让 new-session 对目标成员调用 `stop_run`；本地注册的旧 run 会收到
  `SIGKILL`，这比原来的 `interrupt_now` / `SIGINT` 更强。
- 单成员和 `--all` 现在都并行停止目标成员，取消旧排队执行，并最多等待 3 秒确认
  process-local execution chain 已退出；超时会明确失败，不会伪报 reset 成功。
- 两种模式都不再同步执行 bootstrap run，只重置 TaskSession、清空 member thread 并写入
  bootstrap Prompt；下一条真实用户指令才启动 fresh session，因此命令会快速返回。
- 队列隔离当前仍是 process-local；若未来有多个进程同时消费 Live Room delivery，需把
  队列所有权迁移到 DB-backed worker，不能假设跨进程内存 Map 可见。
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

本 Session 已实际运行并通过：

- `npm run test:live-room-queue`
- `npm run test:scheduled-jobs`
- `npm run test:workflow-watcher`
- `npx tsc --noEmit`
- `git diff --check`

其中 queue 回归明确覆盖“取消的旧排队 delivery 不得稍后执行”和“不等待 agent 完整回复”。

本 Session 已按仓库要求运行
`detect_changes(scope=compare, base_ref=master)`：结果为 **CRITICAL**，原因是当前分支
相对 master 累积 146 个文件、688 个 symbol 的历史差异，影响 197 条流程。该结果不能
证明本批 14 个工作区文件可安全提交；提交前必须再按精确 staged/unstaged 范围审计。

## 下一步

1. 先读本 HANDOVER、253 PLAN、workflow contract 和完整工作区 diff。
2. 用 GitNexus `detect_changes(scope=compare, base_ref=master)` 复核已有改动的真实范围；
   HIGH/CRITICAL 必须先报告，不能直接提交。
3. 当前 `20260726173000_add_workflow_dispatch` 尚未应用；部署 workflow dispatch 前必须
   获得用户明确授权并运行 migration。
4. 用户已明确授权提交和重启相关 user systemd 服务；提交后按 migration 前置条件决定
   可安全重启的服务，禁止让 scheduled-job runner 进入缺表运行态。
5. 服务加载新提交后用真实测试群验收：项目级 disable 不影响其他项目；批准事件只 reset 一次、
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
