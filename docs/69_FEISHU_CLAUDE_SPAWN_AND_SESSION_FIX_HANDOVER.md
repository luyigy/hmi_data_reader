# 69. FEISHU_CLAUDE_SPAWN_AND_SESSION_FIX_HANDOVER

## 日期

2026-04-07

## 本轮目标

排查并修复 Feishu Runtime 中 Claude 子进程无法启动、回复一直卡住的问题，同时解决 session continuity（续聊会话）在服务重启后失效的问题。

---

## 问题一：`spawn claude ENOENT`

### 根因

`buildClaudeChildEnv()` 在构建子进程 PATH 时，只添加了**当前 Node.js 进程版本**对应的 nvm bin 目录：

```typescript
const nvmCurrentBin = `${nvmDir}/versions/node/${process.version}/bin`;
```

但 Feishu Runtime 实际由系统 node（`/usr/bin/node v22.22.0`）启动，而 `claude` CLI 只安装在 `/home/hello/.nvm/versions/node/v22.22.1/bin/`。路径不匹配导致 `ENOENT`。

### 修复

改为读取 nvm versions 目录下**所有**安装版本的 bin 路径并全部加入 PATH，不再依赖 `process.version`。

**修改文件**：`src/lib/real-agents/claude-agent.ts`

---

## 问题二：stale deliveries 导致回复一直卡住

### 根因

服务被 SIGKILL 强杀时，`LiveRoomDelivery` 记录停留在 `running` 状态，`LiveRoomMember.presenceStatus` 停留在 `busy`，导致后续消息处理被阻塞。

### 修复（三层防护）

| 层级 | 机制 | 说明 |
|------|------|------|
| 启动清理 | `feishu-long-connection.ts` startRuntime | 每次重启自动将所有 `running` deliveries 标为 `failed`，将 `busy` 成员重置为 `idle` |
| SIGTERM 处理 | `feishu-standalone-monitor.js` | 收到 SIGTERM 时主动 kill 子进程、清理 DB，在 20s 超时窗口内完成优雅退出 |
| 定时 watchdog | `feishu-long-connection.ts` setInterval | 每 5 分钟扫描一次，将执行时间超过 12 分钟（超过 claude 最大超时）的 stale deliveries 强制标为 `failed` |

**修改文件**：`src/lib/feishu-long-connection.ts`、`scripts/feishu-standalone-monitor.js`

---

## 问题三：服务重启后 session continuity 失效

### 根因

服务崩溃后，`TaskRunParticipant` 和 `TaskRun` 记录停留在 `running` 状态。`findLatestParticipantSession` 要求：

- `participant.status === 'completed'`
- `taskRun.status !== 'failed'`

两个条件均不满足，导致每条新消息都开启一个**全新 session**，而不是续接之前的对话。

### 修复

在启动清理逻辑中增加：

- 有 session ID 的 stale 参与者 → 标为 `completed`（可供续聊）
- 无 session ID 的 stale 参与者 → 标为 `failed`
- Stale task runs → 标为 `completed`（`failed` 状态会被续聊查询排除）

**修改文件**：`src/lib/feishu-long-connection.ts`

---

## 问题四：403 Auth Error 时不回退到新 session

### 根因

使用订阅制（subscription）账号而非 API Key。DB 中存储了大量旧 session ID（原来用 API Key 创建），续聊时触发 `403 Request not allowed`。

但 `INVALID_CLAUDE_CONTINUATION_PATTERNS` 只匹配 `"No conversation found with session ID"`，403 错误不在匹配范围内，导致系统直接失败而不自动回退到新 session。

### 修复

1. 在 `INVALID_CLAUDE_CONTINUATION_PATTERNS` 中增加 403/auth 错误的匹配规则，触发自动回退新 session
2. 清除 DB 中 237 条旧 session ID（`continuationStaleAt` 标记为过期）

**修改文件**：`src/lib/live-room-delivery.ts`

---

## 本轮提交记录

| commit | 说明 |
|--------|------|
| `d86ab77` | fix: resolve spawn claude ENOENT — 所有 nvm bin 路径加入 PATH |
| `68_...` | docs: 本轮 handover 文件（上一轮记录） |
| `d80eda0` | fix: 启动时清理 stale deliveries/members |
| `b4822c2` | fix: SIGTERM handler + 定时 watchdog 防止 stale 积累 |
| `683ac0f` | fix: 启动时修复 stale participants/task runs，恢复 session continuity |
| `1f812c8` | fix: 403 auth error 时回退 fresh session |

---

## 当前状态

- Feishu Runtime 正常运行，claude 子进程可以正常启动
- 服务重启后会自动清理所有 stale 状态
- Session continuity 在正常情况下可以续接；403/session 失效时自动开新 session
- 订阅制账号运行正常

## 注意事项

- Feishu Runtime 使用系统 node（`/usr/bin/node v22.22.0`），而非 nvm 管理的版本
- `claude` CLI 只安装在 `v22.22.1/bin`，不要卸载或移动
- 若将来切换为 API Key 认证，旧的订阅 session ID 同样需要清理（执行 `continuationStaleAt` 标记）
