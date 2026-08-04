---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/383_PLAN_20260804_Inbox优先级议题实施.md
slice: S02
plan_progress: in_progress
---

# HANDOVER · S02 失败可观测性与恢复簇

## 完成内容

### 1. 编排器展示修复——区分「交接 Slice」与「目标 Slice」

修改 `src/lib/scheduled-jobs/workflow-watcher.ts` 的 `workflowContext` 函数与
`src/lib/scheduled-jobs/workflow-validator.ts` 的 `validateWorkflowDocument` 返回值，
使 HANDOVER 卡片明确显示：

- **交接 Slice（HANDOVER）**：S01（已完成移交的 Slice）
- **目标 Slice**：S02（即将执行的目标 Slice）

PLAN 类型文档保持原有 `当前或将执行的 Slice` 标签不变。

**涉及文件**：
- `src/lib/scheduled-jobs/workflow-validator.ts`：`validateWorkflowDocument` 新增返回
  `nextSlice` 字段，由 validator 在 HANDOVER `next_slice` 校验路径中计算。
- `src/lib/scheduled-jobs/workflow-watcher.ts`：`workflowContext` 接受可选
  `targetSlice` 参数，HANDOVER 类型显示区分标签；所有调用点传入
  `document.nextSlice`。
- `src/lib/scheduled-jobs/workflow-status.ts`：slice 解析回退链新增
  `交接 Slice（HANDOVER）` 标签匹配。

### 2. 348——Watchdog 不再误判 Platform Local 长任务

修改 `src/lib/feishu-long-connection.ts` 的周期性 watchdog（每 5 分钟触发）：

- **旧行为**：超过 12 分钟的 `running` delivery 全部标记 `failed`，然后批量将所有 `busy`
  成员改为 `idle`。
- **新行为**：
  1. `findMany` 获取超时 delivery，逐条检查 `getLiveRoomRunningProcess`
  2. Platform Local（codex/claude/kimi-code）若进程仍在注册表中 → **跳过**（长任务）
  3. 非 Platform Local 若进程已退出（`exitCode !== null`）→ 确认失联
  4. 仅对确认失联的 delivery 标记 `failed`
  5. 仅回收失败 delivery 关联的成员（`presenceStatus: busy → idle`），不误伤其他成员

**涉及文件**：
- `src/lib/feishu-long-connection.ts`：新增 `getLiveRoomRunningProcess` 导入；
  重写 watchdog 逻辑为 `findMany` + 逐条活性检查 + 精准回收。

### 3. 376——PLAN 提交链状态反馈

在 `/plan` 流程的 PLAN 生成完成与 Git 提交之间增加阶段状态消息：

- 新增 `系统提示：PLAN 文件已生成（${planPath}），正在提交到版本库...`
- `git commit` 失败时附加 `文件已 git add（${planPath}）但未提交`，区分 add 成功/失败

**涉及文件**：
- `src/lib/live-room-workflows.ts`：在 `planPath` 解析通过后、git add 前插入状态消息；
  增强 `git_commit` 错误消息携带 git add 状态。

### 4. 380 P1——失败消息携带已完成阶段

在 `/plan` 失败提示中新增 `已完成的阶段：约束定义（主持人） → 成员建议（成员A）` 行，
使用户无需翻阅聊天记录即可了解哪些阶段已成功，为后续断点续跑提供上下文。

完整 Workflow Run checkpoint（持久化状态、原子 `paused → running`、幂等键、恢复按钮）
留待后续 Slice 实施。

**涉及文件**：
- `src/lib/live-room-workflows.ts`：catch 块新增 `completedStages` 变量，四类错误
  均附加已完成的阶段列表。

## 验证

- `npx tsc --noEmit` 零错误通过。
- 现有 `/plan`、`/run` 正常路径代码未改动行为。
- `workflowContext` 在 PLAN 文档场景保持 `当前或将执行的 Slice` 标签兼容。
- 周期性 watchdog 仅回收确认失联的 delivery，不再批量清空 `busy` 成员。

## 遗留事项

- **380 P1 完整 checkpoint**：持久化 Workflow Run 状态（独立表或 metadata 字段）、
  原子状态更新、`paused → running` 幂等键、恢复按钮交互。已在错误消息中提供已完成
  阶段信息作为过渡方案。
- **376 完整卡片反馈**：Handoff → PLAN 生成 → Validator → Watcher → 审批卡的全链路
  实时状态跟踪卡片（当前仅覆盖 `/plan` 流程内的阶段提示）。
- **348 执行上限统一终止**：配置了执行上限的任务超时后，由执行器先终止进程再统一
  落库，而非仅改数据库状态。

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/383_HANDOVER_20260804_Inbox_S02_失败可观测性与恢复簇.md`、
`docs/383_PLAN_20260804_Inbox优先级议题实施.md` 和
`docs/workflow/workflow-contract.yaml`，只执行 S03。
完成验证、创建下一 HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
