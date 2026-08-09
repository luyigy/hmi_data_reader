---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/393_PLAN_20260809_LiveRoom指定角色串行流水线.md
slice: S01
plan_progress: complete
---

# HANDOVER · Live Room 指定角色串行流水线

## 完成内容

- `/run feature|debug` 启动前要求 planner、implementer、reviewer、tester 四个可执行且不同的成员；缺失时列出角色并拒绝启动。
- planner 只负责计划、计划定稿和最终总结，implementer 只负责实现，reviewer 负责计划/代码审查，tester 负责测试方案和测试。
- 计划审查和代码审查只接受唯一 `APPROVED`，测试只接受唯一 `PASSED`；否决、失败、结论冲突或缺少明确结论均发布 `workflow_failed` 并立即停止。
- 只有所有阶段和门禁通过后才发布 `workflow_completed`。
- PLAN 审批通过后由 workflow watcher 自动进入同一套四角色串行流水线，不再要求用户补发 `/run feature` 或 `/run debug`。
- PLAN 修订、Workflow 校验修复和 blocker 仍走原有单 Agent 路径，不会误启动实施流水线。
- 审批时固化的 Workflow 权限快照会应用到串行流水线的每一个角色阶段。
- 未实现 Worktree、并行、自动恢复、自动重试或 UI。

## 验证

- `tests/live-room-workflows.test.ts`：通过，覆盖 feature/debug 角色分配、缺失/重复成员拒绝和审查/测试门禁。
- 全部 10 个现有 Live Room 相关测试：通过。
- `tests/workflow-watcher.test.ts`：通过，覆盖批准 PLAN 自动选择角色流水线、PLAN 修订不进入实施流水线。
- `tests/workflow-dispatch-recovery.test.ts`：通过，覆盖批准 PLAN 只入队一次且不广播为普通房间消息。
- `./node_modules/.bin/tsc --noEmit`：通过。
- `npm run check:long-files`：通过，无 1000 行阻断文件；`src/lib/live-room-workflows.ts` 为 537 行。
- 本次文件 `git diff --check`：通过。

## 发现、限制与验收

- GitNexus 增量刷新启动后未完成，原生 `impact` 以退出码 139 失败；已改用完整调用方检索确认 watcher 的普通执行、PLAN 修订、blocker 和校验修复入口，并只让 PLAN/HANDOVER 可执行文档选择角色流水线。
- 未重启服务或执行真实飞书 PLAN 审批；提交后应在包含四个指定角色的 Live Room 生成并批准一个小 PLAN，确认无需输入 `/run feature|debug` 即开始串行阶段，并分别验证 reviewer `CHANGES_REQUESTED`、tester `FAILED` 会停止且不产生 `workflow_completed`。
- 工作区已有的 GitNexus 配置、AGENTS、CLAUDE、scheduled jobs、Feishu 和 inbox 文档改动均未纳入本 Slice。

## 修改文件

- `src/lib/live-room-workflows.ts`
- `src/lib/feishu-workflow.ts`
- `src/lib/scheduled-jobs/workflow-watcher.ts`
- `tests/live-room-workflows.test.ts`
- `tests/workflow-watcher.test.ts`
- `tests/workflow-dispatch-recovery.test.ts`
- `docs/394_HANDOVER_20260809_LiveRoom指定角色串行流水线.md`
