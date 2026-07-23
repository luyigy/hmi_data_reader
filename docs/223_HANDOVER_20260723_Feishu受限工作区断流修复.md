---
doc_type: HANDOVER
doc_status: completed
plan: 221_PLAN_20260722_Feishu工作区授权.md
slice: Phase1-Phase3
plan_progress: complete
next_action: await_acceptance
---

# Feishu 受限工作区断流修复

## 提交

- 分支：`oss-prep`
- 实现提交：`0d018e9 feat(feishu): sandbox authorized workspaces`

## 问题与根因

非管理员 Feishu DM 使用 Platform Local 时先后出现：

1. `stream disconnected before completion`：bubblewrap 只挂载 `/usr`，但 `/usr/lib/ssl/certs` 指向未挂载的 `/etc/ssl/certs`，导致 HTTPS 无法读取系统 CA。
2. `401 Unauthorized: Missing bearer or basic authentication`：房间 `CODEX_HOME/auth.json` 是指向共享 Codex 配置的软链接，沙箱只挂载配置目录，没有挂载软链接目标，Codex 无法读取登录凭据。

## 完成内容

- 新增 `workspaceRoot` 数据字段、迁移和统一的真实路径校验，拒绝 `..`、兄弟目录及符号链接越界。
- 管理员审批或命令必须设置授权根目录；普通用户只能在根目录内切换 cwd。
- 将授权根和网络策略从本地 runner 透传到 Codex/Claude 启动入口。
- 使用 bubblewrap 只写挂载授权根，并只读提供可执行文件、系统 CA、harness 配置及配置目录内有效软链接的真实目标。
- 不支持隔离的 harness 和 Codex on-request app-server 模式明确拒绝，不静默降级。
- 修复存量 P2P binding 缺少 `senderOpenId` 时无法同步新工作区的问题。

## 修改文件

- `docs/221_PLAN_20260722_Feishu工作区授权.md`
- `prisma/schema.prisma`
- `prisma/migrations/20260722173000_add_feishu_workspace_root/migration.sql`
- `src/lib/acpx/runner.ts`
- `src/lib/feishu-access-approval.ts`
- `src/lib/feishu-live-room.ts`
- `src/lib/feishu-long-connection.ts`
- `src/lib/feishu-workspace.ts`
- `src/lib/feishu.ts`
- `src/lib/harness/adapters/claude.ts`
- `src/lib/harness/adapters/codex.ts`
- `src/lib/harness/bubblewrap.ts`
- `src/lib/harness/types.ts`
- `src/lib/real-agents/claude-agent.ts`
- `src/lib/real-agents/codex-agent.ts`
- `tests/bubblewrap.test.ts`
- `tests/feishu-user-management.test.ts`
- `tests/feishu-workspace.test.ts`

## 验证

- `npx tsx tests/feishu-workspace.test.ts`：通过。
- `npx tsx tests/bubblewrap.test.ts`：通过；验证授权根可写、系统 CA 与认证软链接目标可读、`/etc/passwd` 不可见。
- `npx tsx tests/feishu-user-management.test.ts`：通过。
- `npx tsc --noEmit`：通过。
- `git diff --check`：通过。
- 服务重启后的 Feishu DM 实测已恢复。

## 影响与限制

- 修改前 `wrapWithBubblewrap` 尚未被 GitNexus 索引，impact 风险为 `UNKNOWN`；源码核对显示生产调用者为 Codex、Claude 两个本地 harness 入口。
- 提交前两次执行 GitNexus `detect_changes`（`compare master`、`staged`）均因 MCP `Transport closed` 失败，已用精确暂存清单、cached diff、聚焦测试和 TypeScript 检查降级核验。
- 未提交的消息投递、队列、216/217 文档及仓库说明改动不属于本提交，均保留在工作树。
- bubblewrap 仅接入 Codex、Claude；其他 harness 在受限工作区明确拒绝，待确有需求时再逐个适配。

## 后续动作

`next_action: await_acceptance` 不会自动启动新 Slice。当前实测已由用户确认“seems fixed”；如需流程化关闭 221 计划，可在验收记录中确认完成。
