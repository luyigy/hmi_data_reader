---
doc_type: PLAN
doc_status: completed
next_action: await_acceptance
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---
# PLAN · AP 命令中心 Quota Agent 选择

## 目标

在 `/ap menu` 的“运行控制”卡片中增加 Quota 入口。配置的飞书管理员点击后，从当前已绑定
Live Room 的可用 Agent 中选择一个成员并查询 quota，不再手写
`/ap status --quota --agent=<成员>`。

本计划只增加卡片选择层，复用 S03 已实现的命令解析、管理员权限、provider 查询、缓存和结果卡片；
不新增 quota API、数据库字段或第二套 provider 逻辑。

## 已确认现状

- S03 提交 `47088a9` 已实现 `/ap status --quota --agent=<成员>`。
- `/ap menu` 的“运行控制”页只提供普通“状态”快捷按钮；quota 命令仅显示在折叠的命令模板中。
- 命令中心已有动态房间成员选择卡、表单提交和命令结果卡模式，可以直接复用。
- 当前工作区存在与本需求无关的用户未提交改动，实施时只能精确提交本计划相关文件。

## S01：Quota 选择卡

1. 在“运行控制”页增加“Quota…”按钮。
2. 点击按钮时先校验飞书管理员身份；非管理员不得查询 Live Room 或 provider。
3. 管理员通过后读取当前会话绑定的 Live Room，只列出：
   - `backend=platform_local`；
   - `harnessType` 为 `codex`、`kimi-code` 或 `antigravity`；
   - 当前可回复的非用户成员。
4. 选择成员并提交后，构造既有命令：

   ```text
   /ap status --quota --agent=<memberId>
   ```

   后续继续调用既有 `handleFeishuCommand` / `handleStatusCommand`，结果仍使用通用命令结果卡。
5. 房间未绑定、没有可选成员、卡片过期或表单缺值时返回明确 toast，不调用 provider。

## 验证

- 命令中心“运行控制”页包含 Quota 入口；
- 普通用户在绑定房间查询前被拒绝；
- 选择卡只包含当前房间支持 quota 的 Platform Local Agent；
- 表单选择 Kimi、Codex、Antigravity 均生成同一既有 quota 命令；
- 缺失会话、空成员和无效提交 fail closed；
- 既有普通“状态”、房间控制表单和其他命令卡回归通过；
- 相关 ESLint、自执行测试、`npx tsc --noEmit`、`npm run check:long-files`、`git diff --check`
  以及 GitNexus staged `detect_changes` 完成。

## 边界

- 不修改 S03 quota 采集、缓存、凭证或输出语义；
- 不把账户 quota 放入普通 Room payload；
- 不为 Antigravity 伪造 quota，仍返回 `unknown`；
- 不新增依赖、Prisma schema、migration 或通用表单框架；
- 未经用户另行明确授权，不发送真实飞书卡片、不调用真实 provider、不重启服务；
- 实施前对将修改的每个 function/class/method 运行 GitNexus upstream impact，HIGH/CRITICAL
  先报告。

## 完成条件

- 管理员可以完全通过卡片完成“打开 Quota → 选择 Agent → 查看结果”；
- 手工 `/ap status --quota --agent=<成员>` 保持兼容；
- 创建 `plan_progress: complete`、`next_action: await_acceptance` 的 S01 终态 HANDOVER 后停止。
