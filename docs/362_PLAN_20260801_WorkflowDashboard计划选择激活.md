---
doc_type: PLAN
doc_status: completed
next_action: await_acceptance
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · Workflow Dashboard 计划选择激活

## 背景与目标

Workflow Dashboard 已能展示计划队列，但用户不能从队列中直接选择一个未完成 PLAN 进入现有 workflow
校验、审批与执行链。本计划补齐最小控制入口，不新增工作流状态机，也不绕过既有权限和审批。

## S01：选择并激活一个待处理 PLAN

- 在 Dashboard 中提供待处理 PLAN 下拉框和“激活所选 PLAN”按钮。
- 复用管理员/项目审批人权限、40 位 HEAD 乐观锁、运行状态与 pending guard。
- 将选择写入 watcher cursor 的一次性 `selectedPlan`，随后立即触发现有 watcher。
- watcher 消费选择后清除 `selectedPlan`，后续恢复默认候选排序。
- 回归覆盖指定计划优先、一次性消费、权限、过期 HEAD、运行中与 pending 拒绝场景。

## 验收范围

在已绑定 Workflow 项目的飞书会话打开 Dashboard，选择一个未完成且非当前默认最高编号的 PLAN，点击激活；
确认操作被接收、计划进入原有校验/审批链，且刷新后不会持续强制选择同一 PLAN。
