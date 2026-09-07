<!-- [CHANGE-ME] 下文示例中的文档目录前缀 docs/ 按本仓库 branch_spaces.root 实际值调整（如 docs/codex/<空间>/）。 -->

# PLAN 最小模板

从下面选择一种 PLAN。替换尖括号占位符后再提交；结构规则以同一目标 Git ref 的
`docs/workflow/workflow-contract.yaml` 为准，正文质量与 Slice 划分必须遵守合同声明的
`docs/workflow/PLAN-writing-standard.md`。

模板默认保存候选（`await_approval`）。只有用户明确要求“写好后提审”或“提审此 PLAN”时，
才将 `next_action` 改为 `start_first_slice`；该动作仍先发审批卡，批准前不执行 Slice。

## Phase PLAN

```markdown
---
doc_type: PLAN
doc_status: ready
next_action: await_approval
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · <主题>

## S01：<首个 Slice>

<范围与完成标准>

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/<编号>_PLAN_<日期>_<主题>.md` 的 S01；读取目标 HEAD 的 `AGENTS.md`、
`docs/workflow/workflow-contract.yaml` 和本 PLAN。完成验证、创建下一 HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
```

## Interrupt PLAN

```markdown
---
doc_type: PLAN
doc_status: ready
next_action: await_approval
plan_kind: interrupt
roadmap: null
parent_plan: docs/<父PLAN>.md
parent_slice: S01
return_to: S02
---

# PLAN · <阻塞修复主题>

## S01：<修复 Slice>

<范围与完成标准>

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/<编号>_PLAN_<日期>_<主题>.md` 的 S01；读取目标 HEAD 的 `AGENTS.md`、
`docs/workflow/workflow-contract.yaml`、本 PLAN 和 `docs/<父PLAN>.md`。完成验证、创建恢复父 PLAN 的
HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
```
