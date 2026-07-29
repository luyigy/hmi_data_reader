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

## 首次复验仍失败的原因与处理

- S04 实际由 `agent-platform-scheduled-jobs.service` 于 2026-07-29 10:38:17 CST 启动，而不是由
  `agent-platform-feishu.service` 执行。该 scheduled-jobs 进程从 08:18:59 起一直运行旧代码，启动
  日志明确显示 `Exec args: ... --sandbox workspace-write` 和 `Sandbox mode: workspace-write`。
- 权限修复提交 `3c69289` 创建于 10:43:21；随后只在 10:45:52 重启了 Feishu 长连接服务。这既晚于
  S04 启动，也没有重载真正承载 Workflow 的 scheduled-jobs 进程，因此无法改变已运行 S04 的权限。
- 旧 S04 于 10:57:08 结束。它因真实 `.git` 只读，只能使用 `/tmp` 下的替代 index/object directory
  创建临时校验 commit；该临时对象没有移动真实 HEAD，所以 completion gate 正确报告
  `docs/302_HANDOVER_20260729_Feishu命令入口长文件S04交接.md` 仍未提交。
- 确认旧运行结束后，已于 11:05:02 重启 `agent-platform-scheduled-jobs.service`。新进程为
  `active/running`，现在会加载 `3c69289`；正常服务重启没有手工修改 watcher cursor。
- S04 的 4 个源码和 `docs/302_HANDOVER_20260729_Feishu命令入口长文件S04交接.md` 随后于 11:09:00
  提交为 `c606708 refactor(feishu): split command handlers`，相关未提交文件已从工作区消失。
  scheduled-jobs 重启后的 journal 没有与该提交对应的新 Codex 启动记录，因此该提交只证明 S04 已恢复
  并成功写入真实 Git，不能单独作为自动 Workflow 内层 sandbox 参数的日志证据。
- 日志中另有一次包含 `rm -rf` 的 GitNexus 临时安装命令被安全策略拒绝；Codex 最终仍以 code 0 结束，
  它不是本次 completion gate 报错的直接原因。

## 当前可见性命令

- 已有 `/ap workflow policy show`，可显示 `configured`、外层 `effective`、Harness `enforcement`
  和只读 `exceptions`。
- 提交 `a030c7b feat: show workflow codex sandbox mode` 复用实际启动边界的同一常量，在该命令和
  Workflow 卡片中新增：
  `runtime: outer_boundary=bubblewrap_workspace · codex_inner_sandbox=danger-full-access · approval=never`。
- 该行显示当前策略对下一次 Workflow Codex 的有效启动模式；`effective.filesystem=workspace_write`
  仍表示外层 Bubblewrap 边界，`enforcement.sandbox` 仍表示 Harness 是否兑现策略。三者不再混称为
  同一个 sandbox。
- 命令尚不查询某个已运行 PID 的历史原始参数；需要核对单次运行时，仍以对应日志中的
  `[Codex] Exec args` 和 `[Codex] Sandbox mode` 为最终证据。

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
- S06 于 11:22:25 启动，真实日志显示
  `Exec args: exec --json --sandbox danger-full-access --skip-git-repo-check -` 和
  `Sandbox mode: danger-full-access`，确认修复后的 Workflow 已使用预期内层模式。
- 为加载 `a030c7b` 的新展示，`agent-platform-feishu.service` 和
  `agent-platform-scheduled-jobs.service` 于 11:24 重启并恢复 `active/running`；Feishu runtime
  health 为 `healthy`，没有重启 `agent-platform-dev.service`。
- 该次重启错误地中断了刚运行约 104 秒的 S06，Codex 退出 code 为 `null`。当时尚未产生 S06 工作区
  改动，因此没有代码丢失；但 S06 需要由 Workflow 正常重试，不能把服务健康误报为该 Slice 已完成。
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
和 `docs/301_HANDOVER_20260729_WorkflowCodexGit权限修复交接.md`，确认提交 `3c69289` 与 `a030c7b`
已存在，且 `agent-platform-feishu.service` 和 `agent-platform-scheduled-jobs.service` 的运行起点
不早于 2026-07-29 11:24 CST。执行 `/ap workflow policy show`，确认输出同时包含
`outer_boundary=bubblewrap_workspace` 和 `codex_inner_sandbox=danger-full-access`。若需恢复被服务重启
中断的 S06，只从已提交的 `docs/303_HANDOVER_20260729_ACPXRunner长文件S05交接.md` 重新触发 S06；
不要放宽外层边界、不要修改 watcher cursor，也不要复用已结束的旧进程。
