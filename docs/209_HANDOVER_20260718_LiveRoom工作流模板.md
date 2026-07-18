# 209_HANDOVER_20260718_LiveRoom工作流模板

## 任务类型

feature / test / docs

## 所属主线

Workspace 多 Agent 协作。

## 为什么做

Live Room 原有 Hybrid `/run` 只是按成员角色排序，没有阶段职责、上游产物传递和实施前测试方案。用户需要先落地两个固定模板，不引入前端拖拽编排器。

## 修改内容

- 新增 `src/lib/live-room-workflows.ts`
  - 自包含 `feature` 和 `debug` 两个模板。
  - 支持 `/run feature <任务>` 和 `/run debug <任务>`。
  - 按现有成员自动选择 lead / reviewer / tester，角色不全时自动降级到可用成员。
  - `feature` 流程覆盖独立分析、计划、计划审查、测试方案、实施、代码审查、验收测试和总结。
  - `debug` 流程额外强调根因分析、复现方案和回归测试。
  - 每个阶段的结果写回 Live Room，并明确注入后续阶段。
- `src/lib/live-room-delivery.ts`
  - 仅保留薄接入：Hybrid/Execution 遇到模板命令时转交独立 Workflow 模块。
- `tests/live-room-workflows.test.ts`
  - 验证命令解析和三成员 feature/debug 阶段顺序。

本轮没有新增数据库工作流引擎、前端编排器或通用 DSL。阶段记录复用现有 Task Run 和 Task Room 链路。

## 验证结果

- `npx tsx tests/live-room-workflows.test.ts`：通过。
- `npx tsx tests/live-room-scheduling.test.ts`：通过。
- `npx tsx tests/feishu-mode-command.test.ts`：通过。
- `npx tsc --noEmit`：通过。
- `git diff --check`：通过。
- `agent-platform-dev.service` 与 `agent-platform-feishu.service`：均已重启并处于 `active`。

仍需在真实 Feishu Hybrid 房间分别手工执行一次 feature 和 debug 模板。

## 对主线的影响

在不增加前端复杂度的前提下，为三 Agent 软件开发协作提供可立即试用的固定编排路径。

## 下一步建议

1. 真实验收两个模板的阶段输出质量和飞书耗时。
2. 再补 `--handover` 以及单次 Workflow 的 `--lead` / `--reviewer` / `--tester` 指定，不修改成员长期角色。
3. 根据真实输出决定是否增加 `CHANGES_REQUESTED` / `FAILED` 自动返工；第一版不预先实现通用条件引擎。
