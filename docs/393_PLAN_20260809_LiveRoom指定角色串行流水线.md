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

# PLAN · Live Room 指定角色串行流水线

## S01：收紧现有 `/run feature|debug` 角色分工与结果门禁

目标：复用现有 Live Room `/run feature|debug` 编排，让 planner、implementer、reviewer、tester
按角色串行完成同一任务，不再由 implementer 同时承担计划、实现和总结，也不在缺少角色时回退到任意成员。

实施范围：

- 调整 `src/lib/live-room-workflows.ts` 的角色选择和阶段分配：planner 负责计划，implementer 负责实现，
  reviewer 负责计划/代码审查，tester 负责测试方案和测试；四个职责必须由不同成员承担。
- 启动前一次性校验四种必需角色及可执行 harness；任一角色缺失时明确列出缺失角色并拒绝启动，不产生部分阶段。
- 保持 `feature` 与 `debug` 现有串行执行入口，不新增命令、房间 mode 或调度层。
- 将 reviewer 的 `APPROVED` / `CHANGES_REQUESTED` 和 tester 的 `PASSED` / `FAILED` 作为阶段门禁；
  否决、失败或缺少明确结论时立即停止，后续实现/完成阶段不得执行，且不得发布 workflow completed 事件。
- 在 `tests/live-room-workflows.test.ts` 增加最小回归覆盖；如端到端门禁不能通过纯函数验证，只在现有
  Live Room workflow 测试中补一个聚焦用例，不新建通用状态机。

完成标准：

- 四种角色齐备时，feature/debug 的阶段成员与职责严格匹配，并按既定顺序串行执行。
- 缺少 planner、implementer、reviewer 或 tester 时，启动被拒绝且提示可直接指导用户补齐角色。
- reviewer 未批准或 tester 未通过时流程停止；只有全部门禁通过才发布完成消息和
  `workflow_completed` 事件。
- 目标回归测试、`tsc --noEmit`、长文件守卫和 `git diff --check` 通过；已达长文件阻断阈值的文件不增长。

非目标：本 Slice 不接入 Git Worktree，不做并行子任务、自动重试/重启恢复、自动修改审查意见、UI 卡片或
代码图谱；这些能力在串行闭环经真实 Live Room 验收后另立 PLAN。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/393_PLAN_20260809_LiveRoom指定角色串行流水线.md` 的 S01；读取目标 HEAD 的 `AGENTS.md`、
`docs/workflow/workflow-contract.yaml` 和本 PLAN。严格复用现有 `/run feature|debug`，完成四角色分工、
启动校验、审查/测试结果门禁及最小回归验证；不要实施 Worktree、并行、自动恢复或 UI。完成验证、创建下一
HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
