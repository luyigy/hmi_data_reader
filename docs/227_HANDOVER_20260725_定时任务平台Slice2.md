---
doc_type: HANDOVER
doc_status: completed
plan: 224_PLAN_20260725_通用项目定时任务平台.md
slice: S02
plan_progress: in_progress
next_action: next_slice
---

# 227_HANDOVER_20260725_定时任务平台Slice2

## 完成内容

- 新增最小 handler registry 与无外部副作用的 `noop_test` handler。
- 新增 UTC cron 到期匹配、稳定计划周期 idempotency key、PostgreSQL advisory lock、
  超时、运行记录和成功后 cursor 提交。
- Runner 每 15 秒重新读取项目 YAML；同一分钟重复轮询不会重复执行。
- 未注册 handler 的 Job 不执行，因此尚未迁移的 `workflow_watcher` 和
  `long_file_detector` 不会被平台 Runner 消费。
- 新增独立 TypeScript 入口、shell wrapper 和 systemd user unit；unit 尚未安装或启用。
- Platform Local 已执行 Slice 1 的
  `20260725113000_add_scheduled_jobs` migration。

## 验证结果

- 配置 loader 正负例测试通过。
- Runner 集成测试覆盖成功、同周期并发去重、失败、超时和 cursor 成功提交；测试记录
  自动清理。
- 独立 shell 入口启动并响应 SIGINT 正常退出。
- TypeScript、Prisma schema、migration status 和 `git diff --check` 通过。
- GitNexus upstream impact 均为 LOW；最终 `detect_changes` 结果见本次交付记录。

## 当前状态

- Runner service 未安装、未启用，旧 CronJob 未停止。
- `workflow_watcher` 和 `long_file_detector` 没有 handler，平台不会执行它们。
- workflow `legacy.automation_enabled` 仍为 `false`。
- 下一阶段只迁移 long-file detector；切 active 和停止旧 checker 必须经过 shadow
  对比验收。

## 关键入口

- `src/lib/scheduled-jobs/runner.ts`
- `src/lib/scheduled-jobs/handlers.ts`
- `scripts/scheduled-job-runner.ts`
- `scripts/run-scheduled-job-runner.sh`
- `deploy/systemd-user/agent-platform-scheduled-jobs.service`
- `tests/scheduled-job-runner.test.ts`

## 下一步

按 PLAN 实施 Slice 3，复用现有 long-file checker 行为并先做 shadow 对比。

<!-- WORKFLOW_PROMPT_START -->
按 `docs/224_PLAN_20260725_通用项目定时任务平台.md` 实施 Slice 3。先读取
`docs/227_HANDOVER_20260725_定时任务平台Slice2.md`，核查当前工作树、Runner
约定和 `/data1/code/cronJob` 未提交改动；对拟修改符号逐一执行 GitNexus upstream
impact 并报告 blast radius。只迁移 long-file detector handler，先保持 shadow
并与旧 checker 对比；未经稳定性验收不要切 active、不要停止旧 checker，不要迁移
workflow watcher，不要开启 workflow 自动消费。完成后运行测试、TypeScript/Prisma
校验和 GitNexus detect_changes，并创建下一份 HANDOVER。
<!-- WORKFLOW_PROMPT_END -->
