---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: docs/288_PLAN_20260728_Workflow权限边界与同Session校验修复.md
slice: S05
plan_progress: complete
---

# HANDOVER · Workflow Codex Git 权限修复

## 问题与根因

- 飞书启动的 Workflow Codex 可以修改项目源码，但执行 `git add`、`git commit` 等需要写入 `.git`
  的操作时会因权限不足失败，继而让 completion gate 报告仍有未提交的 workflow 文档。
- `/ap new-session --profile=full` 已正确保存 Room 的 Full Access；这次故障不是 new-session 丢失配置。
- Workflow 按 PLAN 288 的安全决策不继承 Room Full Access，而是使用独立的 `workspace` policy。
  外层 Bubblewrap 已把进程限制在项目 realpath workdir，但 Codex 内层同时使用
  `workspace-write`，会再次把 `.git` 视为只读。两层沙箱重复限制，造成“项目可写、Git 元数据不可写”。

## 已完成修复

- 提交 `3c69289 fix: allow workflow codex git writes` 修改
  `resolveWorkflowCodexBoundary`：仅当权限中存在有效 Workflow 快照时，Codex 内层使用
  `danger-full-access`；外层 Bubblewrap 继续作为真实文件系统边界。
- Workflow 的有效边界仍是项目 `workspace_write`、隔离 `/tmp`、网络按快照启用、审批为 `never`，
  workspace 外仅保留既有只读认证和 skills 例外。
- 普通 Room/Task Session 没有 Workflow 快照时仍返回 `null`，继续使用原权限配置；本修复没有把
  Workflow policy 改为继承 Room Full Access，也没有扩大兄弟项目、宿主 `/tmp` 或系统路径权限。
- 对应测试改为断言 Workflow Codex 边界向内层传递 `danger-full-access`，防止恢复成会锁住 `.git`
  的双重沙箱组合。
- S03 纯拆分已先行验证并提交为 `8835787 refactor: split live room delivery`。

## 验证与运行状态

- 通过：
  - `tests/workflow-execution-policy.test.ts`
  - `tests/bubblewrap.test.ts`
  - `src/lib/real-agents/codex-app-server.test.ts`
  - `npm run test:feishu-permission-card`
  - `npm run test:workflow-watcher`
  - `npm run test:workflow-validator`
  - `npm run test:workflow-completion-gate`
  - `npx tsc --noEmit`
  - 相关 ESLint、`npm run check:long-files`、`git diff --check`
- GitNexus pre-edit impact：`resolveWorkflowCodexBoundary` 为 LOW，仅有 Codex execute、resume 和聚焦
  测试 3 个直接依赖；staged `detect_changes` 也为 low，只触及该 symbol。
- `agent-platform-feishu.service` 已于 2026-07-29 10:45:52 CST 重启；长连接恢复，runtime health 为
  `healthy`。没有重启 `agent-platform-dev.service` 或 `agent-platform-scheduled-jobs.service`，
  watcher cursor 未被修改。
- 未发送新的真实飞书 Workflow 指令，因此尚未用外部消息做提交级复验。下一次飞书 Workflow 启动日志
  应显示 Codex 内层 sandbox 为 `danger-full-access`，同时仍由 Bubblewrap 设置项目 `workspaceRoot`。
- 没有 API、数据库 Schema、生产数据或 workflow contract 变化。
- 用户已有的 `AGENTS.md`、`CLAUDE.md` 和 `.codex-tmp/` 改动未修改、未提交。

## 后续使用

- 可直接从飞书重新发送目标 Workflow 的真实执行指令；不需要再次用 Room Full Access 绕过。
- 若仍出现 Git 权限错误，先核对运行是否晚于上述服务重启时间，并检查该次 Codex 启动日志中的 sandbox
  参数和 Bubblewrap workspace；不要放宽 Workflow 外层边界或让其继承 Room Full Access。
- 本 HANDOVER 为终态记录，不自动启动 PLAN 296 的 S04。

## 手动复验提示

如需复验 Workflow Codex Git 权限修复，先读取目标 HEAD 的
`docs/workflow/workflow-contract.yaml`、`docs/288_PLAN_20260728_Workflow权限边界与同Session校验修复.md`
和 `docs/301_HANDOVER_20260729_WorkflowCodexGit权限修复交接.md`，确认提交 `3c69289` 已存在且
`agent-platform-feishu.service` 的运行起点晚于 2026-07-29 10:45:52 CST。只在用户授权的隔离飞书
房间重新执行一次需要 `git add` 和 `git commit` 的 Workflow，确认 Codex 内层 sandbox 使用
`danger-full-access`、外层 Bubblewrap 仍限制在项目 workspace，并确认提交成功且 completion gate
不再报告未提交 workflow 文档。若复验失败，只收集对应运行日志和权限快照后报告，不放宽外层边界、
不修改 watcher cursor、不启动 PLAN 296 的 S04。
