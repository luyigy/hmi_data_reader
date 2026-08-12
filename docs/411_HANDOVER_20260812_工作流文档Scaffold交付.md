---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/409_PLAN_20260812_工作流文档契约闭环.md
slice: S02
plan_progress: in_progress
---

# HANDOVER · 工作流文档Scaffold交付

已完成 S02：新增 `npm run workflow:new`，可从目标 HEAD 的合同与权威模板生成 phase / interrupt PLAN
及 HANDOVER。生成器自动按分支空间最大编号递增并补齐合同位数；HANDOVER 读取目标 PLAN 的 slice，
自动选择 `next_slice` 或 `await_acceptance`，并分别生成恰好一对或零对 Prompt 标记。interrupt PLAN
要求传入父 PLAN、父 slice 与恢复 slice，并自动写入对应 frontmatter。

生成内容在落盘前直接调用 S01 的 validator 核心和 `WorkingTreeReader` 自检；失败时保留 `.tmp`，
通过后以排他写入落盘，避免编号碰撞覆盖。`AGENTS.md` 已要求新文档统一使用生成器，填写正文并
`git add` 后运行 preflight。

验证通过：`test:new-workflow-document`（编号、phase/interrupt、末/非末 slice、Prompt 数量及生成结果
preflight）、`test:workflow-validator`、`tsc --noEmit`、长文件守卫和 `git diff --check`。

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/411_HANDOVER_20260812_工作流文档Scaffold交付.md`、`docs/409_PLAN_20260812_工作流文档契约闭环.md` 和 `docs/workflow/workflow-contract.yaml`，只执行 S03。
完成验证、创建下一 HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
