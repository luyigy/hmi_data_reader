---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/418_PLAN_20260813_Workflow自动推进可靠性.md
slice: S01
plan_progress: in_progress
---

# HANDOVER · Pending超越检查落地核验

已完成 S01：Watcher 入口的 pending 超越检查（对应 408 B01）。核验结论：**该实现已由
`d7b0bd6 fix(workflow): supersede stale pending plans`（2026-08-13 08:40，早于本 PLAN 的
评审修复提交）完整落地**，本 Slice 按 PLAN 完成标准逐项核验通过，未新增代码改动。

**实现核验**（`src/lib/scheduled-jobs/workflow-watcher.ts:376-409`）：进入
`if (previous.pending)` 分支顶层后先做超越检查——`git diff --name-only --diff-filter=AMR
previous.commit head -- <watchRoot>` 扫描候选，经 `selectWorkflowCandidates` 过滤出编号更大的
文档，并逐一以 `validateWorkflowDocument` 校验（无效文档跳过，不误清 pending）；命中有效
superseder 时输出 `summary: head=... pending_superseded=<旧 pending 路径> by=<新文档路径>`，
`delete previous.pending` 后 fall-through 进入正常候选扫描，直接处理更高编号文档，不再重投旧
Slice。未引入 `supersededBy` 等幽灵字段；`mode='shadow'` 时原样返回 cursor（幂等）；被超越的
plan_review 审批卡会 expire。均符合 PLAN「安全守卫」要求（只在存在编号更大的**有效**文档时清空
pending）。

**测试核验**（`tests/workflow-watcher.test.ts:394-416`）：pending=003 PLAN 且 004 HANDOVER
已提交时，shadow 模式输出 `pending_superseded=...003_PLAN...by=...004_HANDOVER` 且
cursor 深比较不变（幂等）；active 模式改选 004 并 `result=session_started`，投递 prompt 为
004 的 NEXT PROMPT（S02），不含旧 PLAN prompt——旧 pending 让位、不再重投旧 Slice。

**验证通过**：`npx tsc --noEmit`、`npm run test:workflow-watcher`（EXIT 0，含上述超越用例）、
`npm run check:long-files`（无 ≥1000 行；`workflow-watcher.ts` 当前 871 行，S02/S03 新增职责
须先抽函数）、`git diff --check`（干净）。PLAN 413 的 acceptance 记录中
`tests/workflow-review-concurrency.test.ts` 的陈旧 mock 失败为既有问题，与本 Slice 无关。

**遗留事项**：无。S02（提交门禁编号唯一性）与 S03（隔离区自动复评）尚未落地，按 PLAN 顺序
串行推进。

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/419_HANDOVER_20260813_Pending超越检查落地核验.md`、`docs/418_PLAN_20260813_Workflow自动推进可靠性.md` 和 `docs/workflow/workflow-contract.yaml`，只执行 S02。
完成验证、创建下一 HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
