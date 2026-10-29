<!-- [CHANGE-ME] 下文示例中的文档目录前缀 docs/ 按本仓库 branch_spaces.root 实际值调整。 -->

# HANDOVER 最小模板

从下面选择与状态转换一致的一种 HANDOVER。替换尖括号占位符后再提交；规则以同一目标 Git ref 的合同为准。

## 继续下一 Slice

```markdown
---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/<PLAN>.md
slice: S01
plan_progress: in_progress
---

# HANDOVER · <S01 结果>

<完成内容、验证和遗留事项>

记录实际结果与原设想的差异、关键假设变化及对后续路线的影响；区分范围内细化与需生效的路线修订。

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/<本HANDOVER>.md`、`docs/<PLAN>.md` 和 `docs/workflow/workflow-contract.yaml`，只执行 S02。
先读取最新代码和本次交付证据，核对目标与前置，记录当前片实施方案再编码。
完成验证、创建下一 HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
```

## 恢复父 PLAN

```markdown
---
doc_type: HANDOVER
doc_status: completed
next_action: resume_parent
plan: docs/<Interrupt-PLAN>.md
slice: S01
plan_progress: complete
---

# HANDOVER · <Interrupt PLAN 完成>

<完成内容与验证>

说明阻塞是否消除、父计划哪些假设需要更新，以及恢复条件是否满足。

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/<本HANDOVER>.md`、`docs/<Interrupt-PLAN>.md`、`docs/<父PLAN>.md` 和
`docs/workflow/workflow-contract.yaml`，恢复父 PLAN 的 S02。先读取最新代码和本次交付证据，核对目标与前置，记录当前片实施方案再编码。
完成验证、创建下一 HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
```

## 终止并等待验收

```markdown
---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/<PLAN>.md
slice: S01
plan_progress: complete
---

# HANDOVER · <完成结果>

<完成内容、验证、验收入口和遗留事项>

对照整体目标说明完成证据、实际路线变化与尚未验证的事项。
```
