---
doc_type: HANDOVER
doc_status: in_progress
next_action: next_slice
plan: docs/288_PLAN_20260728_Workflow权限边界与同Session校验修复.md
slice: S03
plan_progress: in_progress
---

# HANDOVER · Workflow 同 Session 校验 S03 交接

## 完成内容

- completion gate 固定使用首次执行结果保存的原 session/thread id 进行自动纠正，不会因纠正结果变化而
  切换上下文；沿用既有最多两次纠正和相同 validator error fingerprint 再现时提前停止的策略。
- 原 Session 缺失、已结束或 continuation 失败时，不创建或重置 Session。gate 将完整 validator 错误和
  continuation 错误写入 Task Room，然后结束并沿用既有 participant/run 失败收尾，不遗留
  `waiting_for_input` 状态。
- 将同 Session completion 编排从历史超限的 `runner.ts` 提取到
  `workflow-completion-session.ts`；`runner.ts` 从 1808 行降至 1798 行，新模块 68 行。
- 删除 workflow watcher 在 validator 失败时派发 `PLAN_VALIDATE_REPAIR` 新 Session 的路径。
  watcher 仅发送完整错误通知，以 document path + blob 幂等记录；相同 blob 不重复通知，新 blob
  重新校验，未通过的机器可读文档不触发下一 Workflow 动作。
- 未修改 S02 文件系统沙箱、permission card、目标业务仓库、数据库 Schema 或 S04 行为。

## 验证与影响

- `npm run test:workflow-completion-gate` 通过：覆盖原 Codex thread 两次纠正、相同 fingerprint
  提前停止、两次上限，以及原 Session 不可用时的完整降级通知。
- `npm run test:workflow-watcher` 通过：覆盖 validator 失败不派发 repair Session、相同 blob
  通知幂等、新 blob 复验和下一动作阻断。
- `npx tsc --noEmit`、相关 ESLint、`npm run check:long-files`、`git diff --check` 通过；历史超限
  文件未增长，没有新增达到 1000 行的文件。
- GitNexus pre-edit impact：`executeParticipant` 为 CRITICAL（1 个直接调用者、12 个上游 symbol、
  8 条执行流），`workflowWatcherHandler` 和两份聚焦测试为 LOW；新提取 helper 建立索引后为
  CRITICAL（直接调用者仅 runner completion 分支和聚焦测试）。提交前 `detect_changes` 为 HIGH，
  14 个 symbol、7 条流程均落在预期的 `executeParticipant` 和 watcher 路径。修改严格限定在 Workflow
  completion 分支，未改变普通 Task、Live Room、权限卡或通用 continuation 路径。
- 开工前已有的 `AGENTS.md`、`CLAUDE.md` 和 `.codex-tmp/` 改动未修改、未纳入本次提交。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/288_PLAN_20260728_Workflow权限边界与同Session校验修复.md` 的 S04：只统一普通
permission card 与管理员升级流程的语义和展示，使卡片明确显示命令、当前 workdir 边界、授权范围和
有效期，并且只能批准启动策略安全上限内的本次操作；越界操作由沙箱直接拒绝，不发送看似可放行的权限卡。
先读取目标 HEAD 的 `docs/workflow/workflow-contract.yaml`、本 PLAN、
`docs/293_HANDOVER_20260728_Workflow同Session校验S03交接.md`、S01/S02 权限快照与沙箱边界、TaskRun
interaction、in-process approval、Feishu permission card、Session 停止/重置/超时/替代的状态收尾和
现有聚焦测试；对将修改的每个 symbol 先运行 GitNexus upstream impact，HIGH/CRITICAL 先报告。不得开始
S05，不改变 S03 validator 同 Session 纠正或 watcher 通知行为，不扩大 Workflow workspace 策略，不修改
目标业务仓库。确保普通卡不能修改 Workflow policy、不能授予 Full Access、不能越出 workspace；Session
停止、重置、超时或被替代时 pending interaction 立即变为 `cancelled` 或 `expired`，旧卡不能恢复已结束
进程；Codex 保留真实 in-process 批准，其他 Harness 只展示 adapter 确实支持的能力。完成边界内单次批准、
越界拒绝不发卡、旧卡失效和 Harness 能力展示的聚焦测试，以及 TypeScript、相关 ESLint、long-file guard、
`git diff --check` 和 GitNexus `detect_changes` 后提交，并创建 `plan_progress: in_progress`、
`next_action: next_slice` 的 S04 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
