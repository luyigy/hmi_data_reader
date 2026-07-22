# 211_HANDOVER_20260722_Feishu准入审批规划

## 任务类型

bugfix / feature / docs

## 所属主线

临时插队：完成 Feishu standalone 资源异常诊断，并规划 DM 用户准入与 Full Access 管理员审批。

## 为什么做

SQLite 写竞争修复上线后，`/ap status` 仍显示 standalone runtime 有约 396 个线程并判定为 critical。进一步检查发现这不是持续泄漏：服务器向 Prisma 5.22 原生 Query Engine 暴露了 384 个 CPU，Rust Tokio runtime 启动时相应创建了 384 个 worker。

同时需要为新 Feishu 私聊用户增加类似 Hermes 的接入审批：用户看到自己的 `open_id`，管理员在机器人私聊卡片中批准或拒绝。非管理员把 Codex 提升到 Full Access 时也必须由同一管理员审批。

## 修改内容

- `deploy/systemd-user/agent-platform-feishu.service`
  - 增加 `Environment=TOKIO_WORKER_THREADS=8`，只限制 Feishu standalone 进程中的 Prisma/Tokio worker 数量。
- 已将 unit 安装到 `~/.config/systemd/user/agent-platform-feishu.service`，执行 daemon reload 并重启服务。
- Feishu 准入与提权审批仅完成设计，没有修改实现。

## 验证结果

- 修复前：396 threads，其中 384 个名为 `tokio-runtime-w`；主机可见 CPU 数同为 384。
- 重启后 `/proc` 实测：20 threads，其中 Tokio workers 为 8。
- standalone 启动日志：`health: healthy`，SQLite descriptors 为 5。
- `systemctl --user is-active agent-platform-feishu.service`：`active`。
- 当前会话没有暴露 GitNexus MCP server；GitNexus CLI 可用，但本轮只修改 systemd 配置和文档，不涉及函数、类或方法符号。

## 对主线的影响

资源监控误报已解除，Feishu runtime 保持正常运行。DM pairing 和 Full Access 管理员审批尚未实现，应作为下一开发会话的独立功能处理。

## 下一步建议

### 1. 管理员与持久化状态

- 使用 `FEISHU_ADMIN_OPEN_ID` 指定唯一管理员；向该 `open_id` 直接发送私聊卡片，无需保存管理员 `chat_id`。
- 增加 `FeishuUserAccess`，保存用户 `pending / approved / denied / revoked` 状态。
- 增加 `FeishuAdminApproval`，保存 `user_pairing / full_access` 审批、状态、目标、过期时间和审计信息。
- 不要把 pairing 塞进 `TaskRunInteractionRequest`；该表要求已有 Task/Run，新用户接入时并不存在。

### 2. 新用户 DM pairing

- 在普通消息、`/ap` 命令和卡片动作之前统一按 `senderOpenId` 检查准入。
- 管理员和已批准用户正常进入现有流程。
- 新用户首次 DM 时回复其完整 `open_id` 和“等待管理员审批”，只创建 pending 申请，不创建 Live Room、Task 或 Agent session，也不执行或保存首条消息。
- 给管理员发送批准/拒绝卡片；同一 pending 申请只发送一次，避免重复提醒。
- 批准后创建 `feishu:p2p:<chatId>` Binding、默认 Live Room 和默认 Codex，权限保持 Safe Local，并通知用户重新发送消息。
- 后续同时校验 Binding 的 `chatId`、`senderOpenId` 与 `FeishuUserAccess.status`。

### 3. Full Access 审批

- 管理员自己的 Full Access 请求可直接生效。
- 非管理员请求 Full Access 时不修改权限、不启动 continuation；先创建短时 pending 申请并把卡片发给管理员。
- 管理员批准后再复用现有 `grantRightsForRoom()`，然后 continuation 或启动新 run；拒绝时保持原权限。
- 必须覆盖所有提权入口，而不仅是 `/ap grant full`：至少检查 `/ap rights`、`/ap room --profile=full`、`/ap new --profile=full`、`/ap new-session --profile=full` 和 `/api/feishu/grant`。
- 将“是否允许进入 `full_access`”收敛到共享权限边界，防止入口绕过。

### 4. 卡片安全与复用

- 复用 `src/lib/feishu-api.ts` 的 interactive card 发送/更新能力和 `grantRightsForRoom()`，不复用与 TaskRun 强绑定的 interaction resolver。
- 使用独立 action 命令，例如 `admin-approval:approve:<id>` 和 `admin-approval:deny:<id>`，避免与现有 `approve:<TaskRunInteractionRequestId>` 混淆。
- 回调必须验证 `data.open_id === FEISHU_ADMIN_OPEN_ID`。
- 使用 `WHERE id = ? AND status = 'pending'` 的条件更新保证重复点击和并发回调幂等。
- Full Access 请求建议 15 分钟过期；完成后更新原卡片并分别通知申请用户。
- 现有 `/api/feishu/grant?token=...` 是 bearer-link 模式，不应继续作为非管理员 Full Access 的最终授权入口。

### 5. 最小验证

- 未批准用户不能创建 Binding 或触发 Agent。
- 非管理员不能处理管理员审批卡片。
- 重复点击卡片只执行一次。
- Full Access 只有管理员批准后才写入，并且批准前不会 continuation。
- 不同已批准 DM 继续使用独立 `feishu:p2p:<chatId>` Workspace；注意这是会话/任务隔离，不是操作系统级多租户隔离。
