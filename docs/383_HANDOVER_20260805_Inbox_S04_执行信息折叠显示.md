---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/383_PLAN_20260804_Inbox优先级议题实施.md
slice: S04
plan_progress: in_progress
---

# HANDOVER · S04 执行信息折叠显示

> 本 HANDOVER 对应 383 PLAN 的 S04（377）。S04 与 S03 代码路径独立，互相不依赖。

## 1. 完成内容

### 事件 tier 标签（基础层）

**Prisma schema**
- `TaskRunEvent` 新增 `tier` 字段（`String @default("summary")`），枚举值 `summary / detail`
- 数据库已通过 `prisma db push` 同步；迁移文件：`prisma/migrations/20260805161500_add_event_tier/migration.sql`

**类型定义**
- `types.ts`：新增 `TaskRunEventTier` 类型（`'summary' | 'detail'`），`AcpxLiveEventPayload` 新增 `tier` 字段
- `task-chat-types.ts`：`TaskRunEvent` 新增 `tier` 字段

**事件发布（event-bus.ts）**
- `computeTier(eventType)`：`stdout_chunk` / `stderr_chunk` → `detail`，其余 → `summary`
- `publishTaskRunEvent` 自动计算并持久化 `tier`
- WebSocket 推送的 payload 也包含 `tier`

### 飞书端：FeishuProgressTracker 改造为交互卡片 + collapsible_panel

**feishu-progress.ts 重写**
- 从「纯文本消息 + 原位编辑」改为「飞书交互卡片」
- 卡片头部显示：`🔄 Agent 执行中...`（蓝色模板）+ `已完成 N 个步骤`
- 所有工具调用详情收纳在 `collapsible_panel`（默认折叠）
- 同工具名连续调用自动合并计数（`🔧 tool: "preview" ×3`）
- 1.5 秒节流原位更新（`PATCH /im/v1/messages/{id}`）
- 新增 `finalize(summary, success)` 方法：执行结束时发送终态卡片（绿色/红色 header + 结果摘要 + 折叠的工具列表）
- 向后兼容：`onToolEvent` 签名不变，现有调用方无需修改

### Web 端：CollapsibleExecutionBlock 手风琴组件

**新文件：`src/app/tasks/[id]/chat/CollapsibleExecutionBlock.tsx`**
- `CollapsibleExecutionBlock`：将连续 `run_event` 项分组折叠
- 摘要层事件（`tier: 'summary'`）默认外露
- 详细层事件（`tier: 'detail'`）默认折叠，显示 `▶ 详细执行过程 (N 个步骤 / M 次工具调用)`
- 点击展开/收起，展开后显示完整 stdout/stderr 内容
- 支持 `compact` 和 `nested` 两种渲染模式
- 内部 `RunEventItem` 组件：复用原 Timeline 的渲染逻辑（assistant reply / system event / general event）

**TaskChatTimeline.tsx 集成**
- 新增 `groupFeedForFolding`：将连续 `run_event` 项分组成块
- 新增 `groupHasDetail`：检测组内是否有 detail 级事件
- 有 detail 事件的组使用 `CollapsibleExecutionBlock` 渲染
- 无 detail 的组保持原样平铺
- room_message 不受影响
- 使用 `useMemo` 优化分组性能

### S02 诊断联动预留

- `CollapsibleExecutionBlock` 组件通过 `summaryCount` prop 控制摘要层显示数量
- 折叠/展开状态由组件内部 `useState` 管理
- S02 的"查看诊断"按钮可通过以下方式联动：
  1. 给 `CollapsibleExecutionBlock` 传 `data-block-id`（如 `task-run-event-{firstEventId}`）
  2. S02 的错误消息卡片中"查看诊断"按钮点击时 scroll into view + 展开对应 block

## 2. 验证

- `npx tsc --noEmit` 零错误通过
- `npm run check:long-files` 通过（无 ≥1000 行文件）
- `git diff --check` 干净
- Prisma client 已重新生成，`tier` 字段可用
- 数据库已通过 `prisma db push` 同步

## 3. 偏差与未执行项

- **FeishuProgressTracker 不再向后兼容旧的 `editFeishuMessage` 纯文本编辑**：新实现使用交互卡片的 PATCH 端点更新，旧纯文本消息的 `message_id` 无法升级为交互卡片
- **未实现全局切换开关（Toggle）**：ISSUE 中提到的「折叠执行过程 / 展开全部」全局开关和用户偏好记忆暂未实现，作为后续 Slice 的可选增强
- **长内容二次折叠未实现**：超 10 行的单条输出二次折叠（"展开完整输出 (120 行)"）暂未实现

## 4. 遗留事项

- **Feishu 端覆盖范围**：当前只有 `FeishuProgressTracker`（工具调用进度）使用了折叠卡片。完整的 Agent 执行过程（stdout 流式输出）仍按原样发送到飞书
- **Web 端全局开关**：界面右上角的「折叠/展开全部」Toggle 尚未实现
- **S02 诊断联动**：需要在 S02 的错误消息卡片中添加「查看诊断」按钮，并联动打开对应 CollapsibleExecutionBlock

## 5. 修改文件

- `prisma/schema.prisma`：`TaskRunEvent` 新增 `tier` 字段
- `prisma/migrations/20260805161500_add_event_tier/migration.sql`：迁移 SQL
- `src/lib/acpx/types.ts`：新增 `TaskRunEventTier`，`AcpxLiveEventPayload` 新增 `tier`
- `src/lib/acpx/event-bus.ts`：新增 `computeTier`，发布/推送时包含 `tier`
- `src/lib/feishu-progress.ts`：重写为交互卡片 + `collapsible_panel`
- `src/app/tasks/[id]/chat/task-chat-types.ts`：`TaskRunEvent` 新增 `tier`
- `src/app/tasks/[id]/chat/CollapsibleExecutionBlock.tsx`：新文件，手风琴折叠组件
- `src/app/tasks/[id]/chat/TaskChatTimeline.tsx`：集成分组折叠逻辑

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/383_HANDOVER_20260805_Inbox_S04_执行信息折叠显示.md`、
`docs/383_PLAN_20260804_Inbox优先级议题实施.md` 和
`docs/workflow/workflow-contract.yaml`，当前 Slice S04 已完成。
验证通过后创建下一 Slice（S05）的 HANDOVER 或等待指令。
<!-- WORKFLOW_PROMPT_END -->
