---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md
slice: S03
plan_progress: in_progress
---

# HANDOVER · Workflow 自治模式 S03 交接

## 完成内容

- 新增独立的 `manual / semi_auto / auto` 自治合同；它只决定是否自动推进 Workflow 动作，不修改 Live
  Room 的 `discussion / execution / hybrid` mode。
- 项目配置是唯一默认值：现有四个启用的 workflow 项目显式设为 `semi_auto`，未配置项目安全默认为
  `manual`，非法配置在消费点 fail closed。
- `ScheduledJobState.workflowAutonomy` JSON 字段只保存项目级 override 与操作者、请求、预期 HEAD、
  更新时间。模式切换复用现有项目/job advisory lock，不触碰 watcher cursor，也没有新增状态机或表。
- 新增 `/ap workflow autonomy show` 与
  `/ap workflow autonomy set <manual|semi_auto|auto> --head=<HEAD>`。只有平台管理员或项目审批人可切换；
  HEAD 变化视为卡片/命令过期，相同模式重复操作不写数据库。
- Workflow Dashboard 增加三种模式按钮，按钮携带完整 HEAD；长连接 callback 只把既有 project/job/action
  与 expected HEAD 交给同一命令处理路径。S02 的飞书状态、Dashboard 和 Web `/workflow` 同步展示模式及
  `config / override / safe_fallback` 来源。
- runner 将既有 `trigger` 和解析后的自治模式传给 watcher。Manual 阻止尚未开始的自动 PLAN 修订、
  首 Slice、下一 Slice和回父 PLAN，但用户 `/ap job run workflow-watcher` 可手动推进；Semi-auto 自动
  修订和推进已批准 PLAN 内 Slice，但不自动 `resume_parent`；Auto 允许全部四类既有推进动作。
- 降级不会中断正在执行的原子工作单元：切换使用与 runner 相同的 advisory lock，当前 handler 收口后才
  写入新模式，后续动作读取新值。

## 验证结果

- `npm run test:workflow-autonomy`：通过；覆盖三种模式推进矩阵、未配置默认 manual、非法持久值安全回退、
  管理员/审批人权限、非管理员拒绝、未绑定项目、HEAD 过期和重复模式不写入的决策。
- `npm run test:workflow-watcher`：通过；覆盖 manual 定时推进停止、完成回执明确停止以及同一动作由
  manual trigger 恢复。测试中的 non-fast-forward fatal 输出是预期 append-only guard 场景。
- Feishu job command 聚焦测试：通过；覆盖自治命令解析、共享状态字段和 Dashboard HEAD 按钮证据。
- Feishu help command 聚焦测试：通过。
- `npx tsc --noEmit`：通过。
- `npx prisma validate`：通过。
- S03 修改文件定向 ESLint：通过。
- `npm run check:long-files`：通过，无 1000 行阻断文件。
- `git diff --check`：通过。

## 数据库与上线边界

- 新增 migration：`prisma/migrations/20260731113000_add_workflow_autonomy/migration.sql`。
- 只生成了 Prisma Client 并只读运行 `prisma migrate status`；当前共享 PostgreSQL 尚未应用该 migration。
  按仓库安全规则，本 Slice 未擅自修改共享数据库。部署代码或重启服务前必须先由用户授权执行
  `npx prisma migrate deploy`。
- 因共享数据库未迁移，未运行会查询新列的 scheduled runner 数据库集成测试，也未执行真实模式切换、
  服务重启、真实飞书 callback 或浏览器 E2E。
- 未修改公共 API、审批模型、Live Room mode、Session rotation、Handoff 提升或 Roadmap/Inbox。
- 保留且未提交 `.codex-tmp/`、`.playwright-mcp/`、草稿、Inbox 和登录二维码等开工前文件。

## GitNexus 影响

- 索引开工时落后于 S01/S02，已按 `gitnexus-cli` 做增量重建；工具自动改动的 `AGENTS.md`、`CLAUDE.md`
  统计行已原样撤销，未进入 S03。
- upstream impact：`executeScheduledJob` 为 HIGH（4 个直接调用、4 条流程），仅新增传递已有 trigger 与
  自治模式；`buildWorkflowStatus`、`nextStepFor` 为 HIGH，`formatWorkflowStatus` 为 CRITICAL，原因是
  Web、飞书 webhook、长连接和 Dashboard 共用。变更只增加模式字段/手动下一步，并由共享 fixture 验证。
- `workflowWatcherHandler`、完成回执、Dashboard card/action、长连接 card handler、WorkflowPage 为 LOW。
- 未修改 CRITICAL 的 `loadProjectsConfig`；新合同在真正消费 workflow_autonomy 时校验，避免扩大公共配置
  加载器影响面。
- GitNexus `detect_changes --scope compare --base-ref master`：已运行；因 `oss-prep` 相对 `master` 的
  246 个历史变更文件返回 CRITICAL。S03 staged 检查同为 CRITICAL，范围为 18 个代码文件、34 个已索引
  符号、21 条 Workflow Web/飞书 policy/Dashboard/watcher 流程；未扩散到 Live Room mode、Session
  rotation、认证模型或 Roadmap。

## 下一步

执行 PLAN 的 S04，只把用户明确选择的普通 Handoff 讨论提升为一份合同合格、等待审批的 PLAN，并复用
现有 PLAN 导入、审批卡和 watcher；不得开始 Session rotation、上下文水位换代或 Roadmap 自动领取。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md` 的 S04：先读取目标 HEAD 的
`AGENTS.md`、`docs/workflow/workflow-contract.yaml`、本 PLAN、
`docs/337_HANDOVER_20260731_Workflow自治模式S03交接.md`，以及现有 Live Room handoff、`/ap plan`、
PLAN 文档生成/导入、审批卡、workflow review/watcher 和 S03 自治模式实现。保护所有开工前用户改动，
运行 `npm run check:long-files`。只实现一个用户显式选择的“将本轮普通 Handoff 讨论提升为审批 PLAN”
入口：主持 Agent 综合当前根 handoff 链，生成唯一、合同合格的 draft PLAN，导入飞书文档并复用现有审批
卡；批准后按 manual 等待用户启动、semi_auto/auto 自动启动，未经批准不得实施。重复点击、重复 callback
和服务重启必须复用同一 PLAN、审批轮次与首 Slice event key。不得新建 PlanRegistry、第二套审批状态机或
从自由文本猜执行意图，不得开始 S05 Session rotation、S06 水位换代或 S07 Roadmap/Inbox。修改任一
function/class/method 前运行 GitNexus upstream impact，HIGH/CRITICAL 先报告。完成 Handoff transcript
fixture、唯一 PLAN、审批修改/拒绝/批准和三种自治模式启动行为的聚焦测试，以及 TypeScript、定向 ESLint、
`npm run check:long-files`、`git diff --check` 和 GitNexus
`detect_changes({scope: "compare", base_ref: "master"})` 后精确提交，并创建
`plan_progress: in_progress`、`next_action: next_slice` 的 S04 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
