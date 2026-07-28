---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: 271_PLAN_20260728_工作流诊断与飞书操作导航.md
slice: S03
plan_progress: in_progress
---

# HANDOVER · Workflow 阶段可见卡片 S03

## 完成内容

- PLAN 审批卡、启动下一 Session 的 workflow prompt 和终态 workflow 通知都显示所属 PLAN、Slice、计划进度、文档状态与下一动作。
- 所有展示值只来自 YAML frontmatter 和文档路径；缺失值统一显示“未声明”。
- 未改变审批、cursor、Session 或消息路由行为。

## 验证

- `npx tsx tests/workflow-watcher.test.ts`
- `npx tsc --noEmit`
- `npx eslint src/lib/feishu-api.ts src/lib/scheduled-jobs/workflow-watcher.ts tests/workflow-watcher.test.ts`
- `git diff --check`

## 后续

仅继续 S04 验证与终态交接；不得回做 S01-S03，不重启服务，不修改 `workflow-test`。

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/271_PLAN_20260728_工作流诊断与飞书操作导航.md`、
`docs/274_HANDOVER_20260728_Workflow阶段可见卡片S03交接.md` 和
`docs/workflow/workflow-contract.yaml`，只执行 S04：运行命令解析、workflow watcher/validator、相关卡片测试、TypeScript、相关 ESLint、`git diff --check` 和 GitNexus `detect_changes`。如生产构建仍受既有客户端 `child_process` 依赖链阻塞，只记录证据，不在本计划内修复。完成后创建终态 HANDOVER，`plan_progress: complete`、`next_action: await_acceptance`，列出需真人在飞书中验证的诊断输出、帮助分页和卡片阶段展示；提交后停止，不重启服务，不修改 `workflow-test`。
<!-- WORKFLOW_PROMPT_END -->
