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

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/<本HANDOVER>.md`、`docs/<PLAN>.md` 和 `docs/workflow/workflow-contract.yaml`，只执行 S02。
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

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/<本HANDOVER>.md`、`docs/<Interrupt-PLAN>.md`、`docs/<父PLAN>.md` 和
`docs/workflow/workflow-contract.yaml`，恢复父 PLAN 的 S02。完成验证、创建下一 HANDOVER、提交后停止。
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
```
