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

## 目标、非目标与整体验收

填写最终用户结果、明确不做什么，以及证明整项工作完成的标准。

## 现场、路线依据与关键未知

区分已确认事实、假设与设想；引用必要的源码 / 实验依据，说明路线选择和推翻条件。

## 初步路线

列出阶段结果、顺序理由和预计依赖。后续 Slice 只初定目标、边界与未决问题，实施细节临近再定。

## S01：<首个 Slice>

<范围与完成标准>

填写本片目的、可验证结果、前置与未决问题。实施前结合最新现场再确定实现、修改范围和验证办法。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/<编号>_PLAN_<日期>_<主题>.md` 的 S01；读取目标 HEAD 的 `AGENTS.md`、
`docs/workflow/workflow-contract.yaml` 和本 PLAN。先核对最新现场与前置证据，记录当前片实施方案再编码。完成验证、创建下一 HANDOVER、提交后停止。
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

## 阻塞证据与恢复目标

填写原假设如何失效、已确认的阻塞、修复边界及恢复父计划需要满足的条件。

## S01：<修复 Slice>

<范围与完成标准>

填写本片目的、可验证结果、前置与未决问题。实施前结合最新现场再确定实现、修改范围和验证办法。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/<编号>_PLAN_<日期>_<主题>.md` 的 S01；读取目标 HEAD 的 `AGENTS.md`、
`docs/workflow/workflow-contract.yaml`、本 PLAN 和 `docs/<父PLAN>.md`。先核对最新阻塞证据，记录当前片实施方案再编码。完成验证、创建恢复父 PLAN 的
HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
```
