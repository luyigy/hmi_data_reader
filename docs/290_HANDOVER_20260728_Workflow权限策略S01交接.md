---
doc_type: HANDOVER
doc_status: in_progress
next_action: next_slice
plan: docs/288_PLAN_20260728_Workflow权限边界与同Session校验修复.md
slice: S01
plan_progress: in_progress
---

# HANDOVER · Workflow 权限策略 S01 交接

## 完成内容

- 增加 `/ap workflow policy show` 和仅 `FEISHU_ADMIN_OPEN_ID` 管理员可用的
  `/ap workflow policy set --preset=workspace`；设置只接受固定预设，拒绝自定义路径、Full Access
  和额外字段，写回 watcher 实际读取的 `config/projects.yaml`，并使用现有
  `FeishuAdminApproval` 保存操作者、前后值、来源和生效时机审计记录。
- 为全部 `workflow-watcher` job 增加必填 `config.execution_policy.preset: workspace`。项目配置加载和
  watcher 启动共用同一校验器；缺失、非法预设或扩展字段默认失败，仅 policy set 的修复路径允许读取
  缺失配置。
- 从项目 realpath 生成 `configured / effective / enforcement / exceptions` 快照。`effective`
  明确 workspace 可写、每次运行隔离临时目录、网络启用和无需普通审批；`enforcement` 复用 ACPX
  Harness 能力矩阵，不把 `partially_applied` 或 `recorded_only` 描述成已兑现；外部例外均公开为只读。
- Workflow 卡片展示完整快照；普通 Workflow 投递和主持式 PLAN revision 都把同一快照写入本次
  TaskRun 的既有权限 metadata。TaskRun 详情卡展示四类快照，普通 Room 权限和非 Workflow
  `/ap plan` 语义不变。
- 未开始 S02，未新增或接入 Bubblewrap，未改变 validator 派发、permission card 行为、数据库
  Schema 或目标业务仓库。

## 验证与影响

- 聚焦测试通过：workflow policy、project config、workflow watcher、Feishu 命令解析、Workflow
  卡片和 Live Room workflow。
- `npx tsc --noEmit`、相关 ESLint、`npm run check:long-files`、`git diff --check` 通过。ESLint
  仅报告 Task Chat 长页面原有的 4 条 Hook dependency warning，没有新增 error。
- 历史超限文件未增长：Task Chat 2455 行（原 2456）、`feishu.ts` 1457 行（不变）、
  `live-room-delivery.ts` 1678 行（原 1680）；没有新增达到 1000 行的文件。
- GitNexus pre-edit impact 中 `loadProjectsConfig`、`executeAcpxTaskRun` 和 `runLiveRoomPlan` 为
  CRITICAL。实现避开了 `executeAcpxTaskRun` 修改；其余两处只增加策略校验或仅对带 Workflow 快照的
  分支覆盖权限。提交前 `detect_changes` 仍因这些共享入口标记为 critical，受影响流程与预期一致。
- 开工前已有的 `AGENTS.md`、`CLAUDE.md` 和 `.codex-tmp/` 改动未修改、未纳入本次提交。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/288_PLAN_20260728_Workflow权限边界与同Session校验修复.md` 的 S02：只把 S01 的 Workflow 权限快照接入 `platform_local` Codex 的操作系统级执行边界，复用现有 Bubblewrap 和非交互 JSON 路径；项目 realpath workdir 可读写、网络启用、沙箱 `/tmp` 隔离，workspace 外仅允许 S01 已公开的只读认证、配置、skills、plugins 和 rules 例外。先读取目标 HEAD 的 `docs/workflow/workflow-contract.yaml`、本 PLAN、`docs/290_HANDOVER_20260728_Workflow权限策略S01交接.md`、S01 权限模型、ACPX Codex adapter 和 Bubblewrap 实现；对将修改的每个 symbol 先运行 GitNexus upstream impact，HIGH/CRITICAL 先报告。不得开始 S03/S04，不改变 watcher validator 派发或 permission card 行为，不修改目标业务仓库。完成项目内写入、父目录/兄弟项目/敏感路径/Docker socket/宿主 `/tmp`/路径穿越/符号链接逃逸的聚焦测试，以及 TypeScript、相关 ESLint、long-file guard、`git diff --check` 和 GitNexus `detect_changes` 后提交，并创建 `plan_progress: in_progress`、`next_action: next_slice` 的 S02 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
