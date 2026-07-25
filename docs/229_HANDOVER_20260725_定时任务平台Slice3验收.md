---
doc_type: HANDOVER
doc_status: completed
plan: 224_PLAN_20260725_通用项目定时任务平台.md
slice: S03
plan_progress: in_progress
next_action: next_slice
---

# 229_HANDOVER_20260725_定时任务平台Slice3验收

## 完成内容

- 单独安装并启用 `agent-platform-scheduled-jobs.service`；未运行会同时重启 Web
  和 Feishu 的全量安装脚本。
- 连续两个共同自然周期对比平台 shadow 与旧 checker，offender、cursor 和
  changed/cleared 结果一致。
- 将 `long-file-detector` 切为 `active`，确认首个 active 自然周期成功后暂停
  Hermes `eb9e090a23a4`。

## 验收结果

- 13:20、13:30 平台 shadow run 均为
  `offenders=3 changed=0 cleared=0`；旧 checker 对应周期也是 3 个相同文件，
  path、blob、head、lines 全字段一致。
- 13:40 平台 run 为 `active/succeeded`，
  `offenders=3 changed=0 cleared=0`，没有因切换重复发送。
- 平台 unit 当前 `enabled` 且 `active`；Hermes `eb9e090a23a4` 当前 `paused`，
  平台是唯一启用的 long-file 发送者。
- Runner、long-file detector 测试、TypeScript、Prisma validate/migration
  status 和 `git diff --check` 通过。

## 保留边界

- Hermes `coding-handover-watcher`（`32b7e6b62a8c`）未改动。
- `workflow-watcher` 仍为 `enabled: false`、`mode: shadow`；
  `legacy.automation_enabled` 仍为 `false`。
- `/data1/code/cronJob` 的两处用户修改和未跟踪 FIX 文档未触碰。
- 回滚时先将平台 long-file job 切回 `shadow`，确认无 active run，再执行
  `hermes cron resume eb9e090a23a4`。

## 下一步

按计划单独实施 Slice 4：迁移 workflow watcher。先读取旧 watcher 当前代码、
用户未提交改动、运行状态和 workflow contract，对拟修改符号执行 GitNexus
upstream impact；平台先保持 shadow，不停止旧 watcher，不开启 workflow 自动消费。

<!-- WORKFLOW_PROMPT_START -->
继续 `docs/224_PLAN_20260725_通用项目定时任务平台.md` 的 Slice 4。
先读取 `docs/229_HANDOVER_20260725_定时任务平台Slice3验收.md`、
`docs/workflow/workflow-contract.yaml` 和 `/data1/code/cronJob` 的旧 workflow
watcher，保留旧仓库全部未提交改动。对拟修改符号先运行 GitNexus upstream
impact 并报告风险。只迁移 workflow watcher handler 与必要测试，平台保持 shadow，
不要停止 Hermes `32b7e6b62a8c`，不要开启 workflow 自动消费；完成 shadow 对比和
稳定性验收后再另行切 active。
<!-- WORKFLOW_PROMPT_END -->
