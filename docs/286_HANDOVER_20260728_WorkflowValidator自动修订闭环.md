---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: null
slice: workflow-validator-auto-repair
plan_progress: complete
---

# HANDOVER · Workflow Validator 自动修订闭环

## 完成内容

- 提交 `c3cd326`：`/ap plan` 的讨论结果现在先提交；workflow watcher 再负责形式校验。
- 校验失败会在项目飞书群发送路径、commit 和完整错误，并自动投递仅修订该工作流文档的 Coding Agent Prompt；相同文档 blob 不重复通知或投递。
- 校验通过后才进入既有 PLAN 审批卡路径；审批人继续负责内容、范围与业务约束，而非 YAML/Prompt 格式。
- 修复标题型 Slice 规则：使用捕获组 `S01`，不再把完整标题匹配为 Prompt 必填文本；诊断命令也能列出中文路径的候选文档。

## 验证

- `npm run test:workflow-validator`
- `npm run test:workflow-watcher`
- `npm run test:scheduled-jobs`
- `tests/feishu-plan-command.test.ts`、`tests/live-room-workflows.test.ts`、`tests/feishu-job-command.test.ts`
- `npx tsc --noEmit`、`npm run check:long-files`、`git diff --check`
- 使用 `/data1/code/mold-data-webpage-tool` 当前 HEAD 验证 178 PLAN 已通过，且诊断能列出中文路径候选。

## 当前状态

- 科学试模助手的 178 PLAN 已创建飞书文档、发出审批卡，当前等待审批人处理。
- 后续发现：导入飞书文档时正文含两个一级标题，导致文档标题为 `Untitled`。这是独立的小修复：导入前保留唯一开头 H1，并去掉 YAML frontmatter 与重复 PLAN H1。
