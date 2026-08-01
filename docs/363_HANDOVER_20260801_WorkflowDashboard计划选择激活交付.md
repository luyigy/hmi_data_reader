---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/362_PLAN_20260801_WorkflowDashboard计划选择激活.md
slice: S01
plan_progress: complete
---

# HANDOVER · Workflow Dashboard 计划选择激活交付

## 完成内容

- Workflow Dashboard 新增待处理 PLAN 下拉框和“激活所选 PLAN”按钮。
- 激活动作复用管理员/项目审批人权限、项目绑定、40 位 HEAD 乐观锁、job 运行状态和 pending guard。
- 选择只写入 watcher cursor 的一次性 `selectedPlan`，立即触发现有 watcher；不会直接执行，也不会绕过
  PLAN 校验或审批。
- watcher 处理选择后自动清除 `selectedPlan`，不改变后续默认候选排序。
- 已有 pending、任务运行中、HEAD 过期，以及计划已完成、阻塞或重复时会明确拒绝。

## 提交与验证

- 实现提交：`e3b83a9 feat(workflow): activate selected plans from dashboard`
- 通过 Workflow watcher、自治模式、Validator、completion gate、scheduled jobs、Feishu 命令与帮助、
  Git 历史守卫聚焦回归。
- TypeScript、定向 ESLint、长文件守卫和 `git diff --check` 通过。
- GitNexus 最终审计为 HIGH，影响集中在预期的 watcher、Dashboard、scheduled-job 命令与飞书长连接流程；
  未扩散到认证、任务执行 API 或其他业务模块。

## 真人验收

1. 在已绑定 Workflow 项目的飞书会话打开 Workflow Dashboard。
2. 从下拉框选择一个未完成且不是默认最高编号的 PLAN，点击“激活所选 PLAN”。
3. 确认页面立即反馈已接收，并继续出现原有校验、审批或执行状态。
4. 再次刷新 Dashboard，确认已消费的选择没有永久改变计划排序。

## 后续边界

- 本交付只补齐“选择并激活计划”，未增加批量操作、拖拽排序、跳过/暂停、运行详情抽屉或房间级快捷控制。
- 面板与 Live Room 的下一轮用户交互设计先由房间成员讨论并形成明确提案；未经确认不自动实施。
- 当前为终态等待真人验收，不自动启动下一 Slice。
