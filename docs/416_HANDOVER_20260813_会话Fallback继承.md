---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/413_PLAN_20260813_工作流执行权限与会话连续性.md
slice: S03
plan_progress: complete
---

# HANDOVER · 会话Fallback继承

已完成 S03：会话 Fallback 继承（交互期回溯 workflow 末态 session）。PLAN 413 全部 Slice（S01→S02→S03）完成。

**Fallback 实现**（`src/lib/acpx/session-tracking.ts`）：`findLatestParticipantSession` 保持同 role
优先查询不变；新增可选 `allowRoleFallback`，仅当同 role 无命中且显式开启时，放宽 `role` 约束二次查询，
回溯同 Task/Session 中同一 Agent（backend+gateway+harness+agentId）最近一次 completed 的 workflow
participant session。fallback 命中走与同 role 完全相同的过滤（continuationKey 一致性、`continuationStaleAt`、
participant completed、taskRun 非 failed/stopped、permissionConfig 一致、存在可续 session），命中结果带
`viaRoleFallback: true`。派生 continuationKey 内嵌 role，跨 role 天然不匹配——只有显式（role 无关）
continuationKey 的 Live Room 成员能命中 fallback，workflow 内部角色串行（planner/reviewer 等）保持隔离。
权限一致性由既有 permissionConfig 过滤保证：交互期调用点传入的是 `applyWorkflowPermissionSnapshot` 之后的
实际执行权限（S01/S02 决定），权限不一致的历史 session 不会被执行。

**交互期接入**（仅两处，均为交互期投递）：`src/lib/live-room-delivery-execution.ts`
（`executeLiveRoomReplyViaAcpx` 追问投递）与 `src/lib/feishu-grant.ts`（授权后续聊）传入
`allowRoleFallback: true`。workflow 内部角色串行（`runLiveRoomWorkflow`）不调用本函数，不受影响。

**测试**（`tests/acpx-session-tracking.test.ts` 新增，`npm run test:acpx-session-tracking`）：
同 role 命中不走 fallback（只发一次查询）；同 role 无命中 → fallback 继承最近的
`feature:implement` session 且二次查询 where 无 role；fallback 遵循 stale/running/taskRun failed/
权限不一致/无 session 过滤；权限一致的 fallback 候选可继承；未开启 fallback 时同 role 无命中即 null
（角色隔离）；派生 continuationKey 即使开启 fallback 也不跨 role 匹配。

**验证通过**：`npx tsc --noEmit`、`test:acpx-session-tracking`、`tests/kimi-code-integration.test.ts`
（where 断言回归）、`tests/workflow-execution-policy.test.ts`、`tests/feishu-workflow-card.test.ts`、
`tests/live-room-permissions.test.ts`、`tests/new-session-rotation.test.ts`、
`tests/workflow-session-rotation.test.ts`、`npm run test:workflow-watcher`、
`npm run test:workflow-completion-gate`、`npm run check:long-files`、`git diff --check`。

**验收入口**：在绑定 Live Room 中跑一次角色串行 workflow（kimi-code 任一角角色），workflow 完成后在
房间内追问同一 Agent——应续上 workflow 末态 session（`viaRoleFallback` 命中），而非全新会话。

**遗留事项**：
- fallback 命中目前仅在返回值标记 `viaRoleFallback`，未额外投递系统提示；如需房间可见的
  “已继承 workflow 会话”提示，可后续在投递层补充（非本次范围）。
- `config/projects.yaml` 引用的三个项目目录（mold-data-webpage-tool / workflow-test /
  hmi_data_reader）再次缺失，已按 S01/S02 同法重建空目录使测试可运行；仍需从真实检出补全
  （既有问题，非本次引入）。
- PLAN 413 的 `full_access` preset 豁免范围与审批 opt-in 评审（PLAN「落地顺序与安全守卫」节）
  仍需人工评审，不阻塞本 PLAN 验收。
