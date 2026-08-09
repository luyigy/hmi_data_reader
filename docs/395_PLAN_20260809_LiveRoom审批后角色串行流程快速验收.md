---
doc_type: PLAN
doc_status: ready
next_action: start_first_slice
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · Live Room 审批后角色串行流程快速验收

## S01：无改动冒烟验收

只验证 PLAN 审批后是否自动进入现有角色串行流水线，不实施业务功能。

验收范围：

- 房间内 4 个独立角色 `planner`、`reviewer`、`tester`、`implementer` 均可执行。
- 审批本 PLAN 后，无需补发 `/run feature` 或 `/run debug`，系统自动依次展示 8 个阶段：实施计划、计划审查、计划定稿、测试方案、功能实施、代码审查、验收测试、最终总结。
- 计划审查和代码审查仅输出通过结论 `APPROVED`；验收测试仅输出通过结论 `PASSED`；功能实施明确输出 `NO_CHANGES` 和“修改文件：无”。
- 最终出现 `feature 工作流已完成`，且测试期间不修改文件、不提交 Git、不重启服务、不执行耗时测试。

允许的轻量只读检查仅限 `git rev-parse --short HEAD` 和 `git status --short`。任一阶段失败、顺序不符、需要再次手动启动工作流或产生仓库改动，均视为验收失败并停止。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/395_PLAN_20260809_LiveRoom审批后角色串行流程快速验收.md` 的 S01；读取目标 HEAD 的 `AGENTS.md`、`docs/workflow/workflow-contract.yaml` 和本 PLAN。此任务只验证角色串行调度：禁止修改文件、提交 Git、重启服务或执行耗时测试。各阶段只完成当前阶段并简短返回；计划审查和代码审查通过时只使用结论 `APPROVED`，不要出现另一个门禁词；验收测试通过时只使用结论 `PASSED`，不要出现另一个门禁词；功能实施输出 `NO_CHANGES` 和“修改文件：无”。最终总结报告 8 个阶段是否按顺序完成。
<!-- WORKFLOW_PROMPT_END -->
