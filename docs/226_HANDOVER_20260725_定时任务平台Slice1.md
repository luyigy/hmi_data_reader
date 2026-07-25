---
doc_type: HANDOVER
doc_status: completed
plan: 224_PLAN_20260725_通用项目定时任务平台.md
slice: S01
plan_progress: in_progress
next_action: next_slice
---

# 226_HANDOVER_20260725_定时任务平台Slice1

## 完成内容

- 新增 `config/projects.yaml`，示例项目含 `workflow_watcher` 和
  `long_file_detector` 两个 shadow Job。
- 新增项目配置 loader、校验和按 chat/project/job 查询。
- 新增 `ScheduledJobState`、`ScheduledJobRun` Prisma 运行态模型和 migration。
- 新增一个可运行配置测试，并加入 YAML 解析依赖。
- workspace root 默认限制为 `/data1/code`，可用
  `SCHEDULED_JOB_WORKSPACE_ROOTS` 覆盖。
- 将来源仓库的 workflow 文档本地化到本仓库；自动消费保持关闭。

## 验证结果

- 示例配置读取为 1 个项目、2 个 Job。
- 重复 `chat_id`、未知 Job 类型、相对路径和非法 cron 均被拒绝。
- TypeScript 检查、Prisma schema 校验和 `git diff --check` 通过。
- GitNexus 结论为 LOW；未影响既有执行流程。

## 当前状态

- 未启动 Runner，未执行数据库 migration，未停用旧 CronJob。
- 旧 watcher/checker 仍是正式执行者。
- workflow 合同绑定 `refs/heads/oss-prep`，历史截止点为
  `76534af03d7ed3c7e3e1973c892da439c7b6e6dd`。
- `legacy.automation_enabled` 为 `false`；Slice 4 接入 watcher 前不得开启。

## 已知事项

- `openclaw cron list` 未显示两个旧任务；正式切换前仍需确认 Hermes 注册归属。
- Slice 2 只实现 Runner、锁、超时、运行记录、cursor 和测试 handler，不迁移正式
  Job。

## 下一步

实施 PLAN Slice 2，并保持所有真实 Job 为 shadow/未注册状态。

<!-- WORKFLOW_PROMPT_START -->
按 `docs/224_PLAN_20260725_通用项目定时任务平台.md` 实施 Slice 2。先读取本交接，
核查当前工作树和数据库约定；对拟修改的函数、类、方法逐一执行 GitNexus upstream
impact 并报告 blast radius。只实现通用 Runner、并发去重、超时、运行记录、cursor
成功提交、无副作用测试 handler 和独立启动方式；不要迁移 long-file detector 或
workflow watcher，不停旧 CronJob，不开启 workflow 自动消费。完成后运行测试、
TypeScript/Prisma 校验和 GitNexus detect_changes，并创建下一份 HANDOVER。
<!-- WORKFLOW_PROMPT_END -->
