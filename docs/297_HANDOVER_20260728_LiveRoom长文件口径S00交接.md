---
doc_type: HANDOVER
doc_status: in_progress
next_action: next_slice
plan: docs/296_PLAN_20260728_LiveRoom受控接力Codex遥测与长文件治理.md
slice: S00
plan_progress: in_progress
---

# HANDOVER · Live Room 长文件口径 S00 交接

## 完成内容

- long-file runtime baseline 与定时 detector 统一读取目标 HEAD 的
  `docs/workflow/workflow-contract.yaml.large_files`，项目配置不再重复阈值、扩展名或忽略路径。
- runtime Prompt 与 detector 均按 `ignored_path_parts` 的任意路径段排除 `.next`、`node_modules`、
  `dist`、`build`、迁移和 vendor 等内容。
- 飞书 detector 通知合并展示本次变化数、超限变化/恢复明细、当前超限业务源码总数与完整 40 位 Git SHA；
  未发送真实飞书消息。
- S00 开工 HEAD `e5928de41b2c509e091e895912891f792a60e977` 与审阅基线
  `067ccd878b0aeaf74d5af624e04e40ce85c5d5ff` 均只识别 6 个历史超限业务源码。
- completion gate 状态转换、业务长文件、handoff、Codex telemetry、服务和生产数据均未修改。

## 验证

- `npm run test:long-file-detector`
- `npm run test:acpx-long-file-runtime-context`
- `npm run test:long-file-guard`
- `npm run test:workflow-completion-gate`
- `npm run test:scheduled-jobs`
- `tests/project-config.test.ts`
- `npx tsc --noEmit`
- 相关 ESLint、`npm run check:long-files`、`git diff --check` 与 GitNexus `detect_changes`

## 工作区保护

开工前已有的 `AGENTS.md`、`CLAUDE.md` 和 `.codex-tmp/` 改动未修改，不纳入 S00 提交。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/296_PLAN_20260728_LiveRoom受控接力Codex遥测与长文件治理.md` 的 S01：只纯拆分
`src/app/tasks/[id]/chat/page.tsx`。先读取目标 HEAD 的 `docs/workflow/workflow-contract.yaml`、本 PLAN、
`docs/297_HANDOVER_20260728_LiveRoom长文件口径S00交接.md`、Task Chat 页面及其直接依赖和现有聚焦测试；
确认并保护开工前用户的未提交改动，运行 `npm run check:long-files`。对将修改的每个 symbol 先运行
GitNexus upstream impact，HIGH/CRITICAL 先报告。按现有 feature 责任提取 timeline/message rendering、
composer 与控制、权限编辑、run history/participant inspector、类型和纯派生函数；页面入口只保留数据
编排与布局。原文件和新增文件均须低于 800 行，请求、Socket、审批、权限、执行、续接和交互语义不变。
不得开始 S02 或其他 Slice，不修改长文件规则、handoff、Codex telemetry、服务或生产数据。完成聚焦测试、
TypeScript、相关 ESLint、long-file guard、`git diff --check` 和 GitNexus `detect_changes` 后提交，并创建
`plan_progress: in_progress`、`next_action: next_slice` 的 S01 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
