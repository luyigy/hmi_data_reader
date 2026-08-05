---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/383_PLAN_20260804_Inbox优先级议题实施.md
slice: S03
plan_progress: in_progress
---

# HANDOVER · S03 Agent 职责分工与意图路由 + AP 命令卡片入口

> 本 HANDOVER 对应 383 PLAN 的 S03（382 + 375）。S03 与 S02 代码路径独立，互相不依赖。

## 1. 完成内容

### 382：Agent 职责分工与意图路由

**Prisma schema**
- `LiveRoomMember` 新增 `specialty` 字段（`String?`），枚举值 `documentation / diagnostics / implementation / general`，独立于 `role`
- 数据库已通过 `prisma db push` 同步；迁移文件：`prisma/migrations/20260805153048_add_specialty/migration.sql`

**类型定义**
- `LiveRoomMemberPayload`（`live-room-types.ts`）新增 `specialty: string | null`
- `LiveRoomMember`（`types/index.ts`）新增 `specialty?: string | null`
- `serializeLiveRoomMember`（`live-room-members.ts`）透传 `specialty`

**意图识别**
- `detectDocumentationIntent(content)`（`live-room-messages.ts`）：检测 7 类文档/记录意图模式
  - 写进 inbox / 出 FIX 文档 / 出文档 / 记录决定 / 写进 inbox / 记一下 / 整理文档
  - 自动剥离开头的 `@/$mention` 前缀，避免把提及本身误判为意图

**意图路由**
- `findDocumentationSpecialist(members)`（`live-room-messages.ts`）：查找 `specialty === 'documentation'` 且 `canReply` 的成员
- `postFeishuMessageToBoundLiveRoom`（`feishu-live-room.ts`）：无显式 `@提及时`，若检测到文档意图且存在文档专员，自动将消息路由给该专员（设为 `primaryTargetMemberId`）
- 消息 metadata 中附带 `specialtyRoute: 'documentation'` 标记
- 不影响现有 `@mention` 显式指定、`mentionedAll`、`ROLE_ORDER` / `ROLE_PRIORITY` 逻辑

**`/ap specialty` 命令**
- `handleSpecialtyCommand`（`feishu-live-room-commands.ts`）：支持 `/ap specialty --member=<name> --specialty=<documentation|diagnostics|implementation|general>`
- 已注册到命令解析器（`feishu-command-parser.ts`）和调度器（`feishu.ts`）

### 375：AP 命令卡片入口

**命令卡片（`feishu-help.ts`）**
- 房间分类「常用操作」新增：
  - `功能开发 /run feature` 按钮
  - `排障修复 /run debug` 按钮
- 房间分类表单按钮新增（替换旧"发送消息"入口）：
  - `功能开发…` → `form-run-feature`（输入任务描述 → 提交 `/run feature <desc>`）
  - `排障修复…` → `form-run-debug`（输入问题描述 → 提交 `/run debug <desc>`）
  - `文档与记录…`（primary_filled 高亮）→ `form-documentation`（输入文档/记录内容 → 提交文本消息）
- 帮助页新增 `/ap specialty` 命令模板

## 2. 验证

- `npx tsc --noEmit` 零错误通过
- `npm run check:long-files` 通过（无 ≥1000 行文件）
- `git diff --check` 干净
- Prisma client 已重新生成，`specialty` 字段可用
- 数据库已通过 `prisma db push` 同步

## 3. 偏差与未执行项

- **迁移通过 `db push` 而非 `migrate dev`**：shadow database 与现有 `init` 迁移不兼容（PostgreSQL `datetime` 类型问题），属于存量问题，不影响本次改动
- **未修改四个历史超限文件**：`parameter_runs.py / routes.py / test_measurement_agent.py / test_trial_parameter_runs.py` 行数不变
- **357 RBAC 不在本 Slice 范围**：按 PLAN 排在 S05
- **GitNexus detect_changes 未执行**：MCP 工具在当前会话不可用；已用人工 diff 抽查 + `tsc --noEmit` 替代

## 4. 遗留事项

- **意图路由仅覆盖飞书入口**：Web 端直播间的消息路由（HTTP API）未接入 `detectDocumentationIntent`；当前只有飞书 DM / 群消息会触发文档专员路由
- **卡片按钮通过 `/ap chat` 中继**：`/run feature` / `/run debug` 表单提交为 `/ap chat /run feature <desc>`，通过聊天消息中继到 Live Room 后再触发工作流，而非直接启动
- **specialty 未在 Web Dashboard 展示**：前端成员列表/详情页未显示 `specialty` 字段，需后续 Slice 补 UI

## 5. 修改文件

- `prisma/schema.prisma`：`LiveRoomMember` 新增 `specialty` 字段
- `prisma/migrations/20260805153048_add_specialty/migration.sql`：迁移 SQL
- `src/lib/live-room-types.ts`：`LiveRoomMemberPayload` 新增 `specialty`
- `src/types/index.ts`：`LiveRoomMember` 新增 `specialty`
- `src/lib/live-room-members.ts`：`serializeLiveRoomMember` 透传 `specialty`
- `src/lib/live-room-messages.ts`：新增 `detectDocumentationIntent`、`findDocumentationSpecialist`
- `src/lib/feishu-live-room.ts`：`postFeishuMessageToBoundLiveRoom` 文档专员路由
- `src/lib/feishu-live-room-commands.ts`：新增 `handleSpecialtyCommand`
- `src/lib/feishu-command-parser.ts`：`specialty` 加入命令白名单
- `src/lib/feishu.ts`：调度器接入 `handleSpecialtyCommand`
- `src/lib/feishu-help.ts`：卡片新增 `/run feature`、`/run debug` 按钮 + 文档与记录表单入口

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/383_HANDOVER_20260805_Inbox_S03_Agent职责分工与意图路由.md`、
`docs/383_PLAN_20260804_Inbox优先级议题实施.md` 和
`docs/workflow/workflow-contract.yaml`，只执行 S04。
完成验证、创建下一 HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
