---
doc_type: FIX
doc_status: completed
next_action: none
---

# FIX · Antigravity 受限运行接入 Bubblewrap 沙箱

## 问题与根因

- Live Room `/plan` 编排中，成员 `antigravity` 以 `workspace-write` 权限进入受限路径后，启动约 0.7 秒即以非零状态退出，唯一 stderr 为一行 tcmalloc 警告，平台据此将参与者记为 `failed`，编排器随后按设计停止，根本未进入主持人的 PLAN 修订/提交阶段。
- 直接对话时 `antigravity` 使用 `full_access`（`--dangerously-skip-permissions`）运行正常；只有进入受限路径才崩溃。
- 根因：受限路径此前**只依赖 Antigravity 自带的 `--sandbox` 标志**，而没有像 codex/claude/kimi-code 一样用平台侧 Bubblewrap 强制工作区与网络边界。服务重启加载了工作区里尚未提交的受限模式改动后才暴露该问题。
- 同时 `executeViaLocalHarness` 的受限 Feishu 工作区白名单未包含 `antigravity`，受限房间会直接抛出 `受限 Feishu 工作区暂不支持 harness: antigravity`。

## 修复

复用既有 `wrapWithBubblewrap`（`src/lib/harness/bubblewrap.ts`，与 codex/claude/kimi-code 同一套），让 Antigravity 受限运行走平台侧 Bubblewrap，而不是 CLI 自带 `--sandbox`：

- **`src/lib/acpx/runner-harness.ts`**：受限 Feishu 工作区允许的 harness 白名单加入 `antigravity`，不再直接抛错。
- **`src/lib/harness/adapters/antigravity.ts`**：把上下文中的 `workspaceRoot` 与 `networkAccess` 透传到 `executeAntigravityTask`；受限运行由 Bubblewrap 强制工作区和网络边界。能力摘要更正为“受限运行由 Bubblewrap 强制工作区和网络边界，full access 使用 `--dangerously-skip-permissions`”；本地 `networkAccess` 与 `writableRoots` 由 `recorded_only` 改为 `applied`。
- **`src/lib/real-agents/antigravity-agent.ts`**：新增 `workspaceRoot` / `networkAccess` 配置；在 `spawn` 前用 `wrapWithBubblewrap` 包装 `agy` 命令，并把 `~/.gemini` 作为只读 `configPaths` 绑定进沙箱，保证受限运行也能读到 Gemini 项目绑定配置。`full_access`（无 `workspaceRoot`）路径保持原样，不受影响。

## 验证

- `node ... tests/antigravity-agent.test.ts`：通过（退出码 0）。新增 `sandbox` 用例验证：受限运行下无法访问工作区外文件、可在工作区内写入，且输出正确；并新增端到端 `executeViaLocalHarness` 集成断言，确认 `workspace-write` 权限配置下 Bubblewrap 包装后任务正常完成。
- `node ... tests/feishu-room-controls.test.ts`：通过（`Feishu room control checks passed`）。新增断言：`antigravity` + `platform_local` 在 `safe_local` 下支持房间工作区约束。
- `npm run check:long-files`：通过，无达到 1000 行阻断阈值的文件。
- 未新增数据库 Schema、迁移或第二套状态机；未改变审批、卡片入口或 Workflow Dashboard。

## 防止复发与后续边界

- 受限运行的边界统一由 `wrapWithBubblewrap` 强制（工作区 bind、网络 `--unshare-all`、配置只读 bind），不再依赖各 CLI 自带沙箱标志的可靠性。
- `full_access` 路径行为不变；权限边界仍由现有 `permissionConfig` 与房间工作区约束决定。
- 本修复与“失败恢复收据与断点继续”（见 `docs/inbox/` 相关 ISSUE）正交：本修复让受限 Antigravity 能正常启动，恢复议题则负责在任意成员失败时给出准确提示与续跑能力。
