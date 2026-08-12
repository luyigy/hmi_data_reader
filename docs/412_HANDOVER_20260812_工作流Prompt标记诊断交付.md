---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/409_PLAN_20260812_工作流文档契约闭环.md
slice: S03
plan_progress: complete
---

# HANDOVER · 工作流Prompt标记诊断交付

已完成 S03。共享 validator 的 `promptFrom()` 仍严格执行合同定义的可执行动作一对标记、终态动作
零标记语义，但标记失败现在会输出独立 code、start/end 实际数量与所有出现行号：可执行动作漏标记为
`PROMPT_MARKERS_MISSING`，多余标记为 `PROMPT_MARKERS_INVALID`，终态误含标记为
`PROMPT_FORBIDDEN`。修复模板会按实际情况直接提示补齐缺失标记、删除多余标记或清除终态 Prompt。

preflight 文本模式现逐项输出 `ERROR [code] [location]`、实际数量和修复动作；JSON 模式沿用同一
`WorkflowValidationIssue`，可供 Agent 按 code 消费。测试覆盖多对、半对、终态含标记、可执行漏标记
四类场景，并验证文本与 JSON 输出。软容忍评估后未纳入：合同明确要求终态零标记，放宽会改变现有
判定语义并与本 Slice 的不回归守卫冲突。

验证通过：`npm run test:workflow-validator`、`npm run test:new-workflow-document`、`npx tsc --noEmit`、
`npm run check:long-files` 和 `git diff --check`。
