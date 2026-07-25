---
doc_type: HANDOVER
doc_status: completed
plan: 224_PLAN_20260725_通用项目定时任务平台.md
slice: S03
plan_progress: in_progress
next_action: next_slice
---

# 228_HANDOVER_20260725_定时任务平台Slice3Shadow

## 完成内容

- 将旧 `long_file_checker.py` 的固定 ref tree 扫描、扩展名/排除路径过滤、
  `>= threshold`、blob/行数变化和 cleared 语义迁移为
  `long_file_detector` handler。
- handler 已注册到通用 Runner；阈值、扩展名、排除路径和飞书群均来自项目配置。
- 项目 schedule 与真实 Hermes 旧任务对齐为每 10 分钟，mode 保持 `shadow`。
- shadow 只生成摘要和数据库 cursor；只有显式 `active` 才通过平台 Feishu API
  发往项目绑定群。

## 对比与验证

- 平台与旧 Python checker 在固定 commit
  `ebe9182bebcc8ede4691428459e27c3ad292771e` 上结果完全一致：3 个 offender 的
  path、blob、head、lines 全字段相同。
- 真实 Runner 数据库路径完成一次 shadow run：
  `succeeded`，`offenders=3 changed=3 cleared=0`，无外部消息。
- 测试覆盖首次发现、未变化不重复、同线路 blob 变化、cleared，以及 active
  消息使用项目绑定 `chat_id`。
- 配置测试、Runner 测试、TypeScript、Prisma validate/migration status 和
  `git diff --check` 通过。

## 当前状态

- 平台 Job 仍为 `shadow`；Runner systemd unit 未安装、未启用。
- Hermes `long-file-checker`（`eb9e090a23a4`）仍 active，最近运行正常。
- Hermes `coding-handover-watcher` 未改动；workflow
  `legacy.automation_enabled` 仍为 `false`。
- `/data1/code/cronJob` 的两处用户修改和一份未跟踪 FIX 文档均未触碰。
- 当前仅完成一次真实 shadow run，不满足稳定观察窗口；不得切 active 或停止旧
  checker。

## 关键入口

- `src/lib/scheduled-jobs/long-file-detector.ts`
- `src/lib/scheduled-jobs/handlers.ts`
- `config/projects.yaml`
- `tests/long-file-detector.test.ts`

## 下一步

继续完成 Slice 3 稳定性验收。只安装/启用 scheduled-jobs unit，不使用会同时重启
Web/Feishu 的全量安装脚本；观察多个旧 checker 周期，逐次比较 offender 和
changed/cleared 结果。验收通过后先切平台 active，确认平台成为唯一发送者，再停
Hermes `eb9e090a23a4`。在此之前不要开始 Slice 4。

<!-- WORKFLOW_PROMPT_START -->
继续 `docs/224_PLAN_20260725_通用项目定时任务平台.md` 的 Slice 3 稳定性验收。
先读取 `docs/228_HANDOVER_20260725_定时任务平台Slice3Shadow.md`，核查工作树、
平台 shadow run、Hermes `eb9e090a23a4` 和 `/data1/code/cronJob` 未提交改动。
只安装并启用 scheduled-jobs systemd user unit，不要运行会重启 Web/Feishu 的
全量安装脚本；跨多个旧 checker 周期对比 offender 与 changed/cleared。未达到
稳定性验收前不要切 active、不要停止旧 checker；验收后先切 active 并确认平台为
唯一发送者，再停 `eb9e090a23a4`。不要迁移 workflow watcher，不要开启 workflow
自动消费。完成后运行测试、TypeScript/Prisma 校验和 GitNexus detect_changes，
并创建下一份 HANDOVER。
<!-- WORKFLOW_PROMPT_END -->
