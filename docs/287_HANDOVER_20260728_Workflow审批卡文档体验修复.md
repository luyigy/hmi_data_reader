---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: null
slice: workflow-review-card-ux
plan_progress: complete
---

# HANDOVER · Workflow 审批卡与文档体验修复

## 完成内容

- `96528b3`：导入飞书的 PLAN 在写入前移除 YAML frontmatter 和重复一级标题，仅保留一个开头 H1。新文档不再以 `Untitled` 创建，也不重复显示标题；既有文档不回填修改。
- `ab610de` 与 `16abe75`：PLAN 审批卡和补充修改意见卡的文本框统一为初始 6 行、最大 12 行、全宽，并在 PC 端按输入内容自动扩展。

## 验证

- `npm run test:workflow-watcher`
- `npm run test:workflow-validator`（标题导入修复）
- `npx tsc --noEmit`
- `git diff --check`

## 已知边界

- 飞书卡片输入组件没有原生全屏编辑模式；超过 12 行后使用组件自身滚动。
- 已发送的卡片和已创建的 `Untitled` 文档不会自动更新；新服务实例之后新发的卡片和新导入的 PLAN 才使用上述布局与标题。
