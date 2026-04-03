# 50 Feishu 双向中继 & SSH 直连 Harness 交接文档

## 日期
2026-04-03

## 本次工作背景

上一篇（49）记录了飞书长连接已跑通，但 agent 在 live room 里的回复无法自动回传飞书，
同时普通消息（非 `/ap` 指令）在已绑定的飞书群里会被静默丢弃。
此外用户希望在注册好 SSH 主机后，可以直接从飞书调用远端 ACPX Harness，不需要依赖 OpenClaw gateway。

---

## 本次实现内容

### 1. Live Room → 飞书 自动回传（agent replies relay）

**问题**：agent 在 live room 里写回复，飞书侧完全看不到。

**方案**：新建 `src/lib/feishu-relay.ts`，只依赖 `prisma` 和 `feishu-api`，
无任何对 `live-room-delivery.ts` 的引用，避免循环依赖。

核心函数：
```typescript
relayAgentReplyToFeishu({ roomId, agentDisplayName, content })
```
逻辑：查 `FeishuConversationBinding` 表，若该 live room 绑定了飞书会话，
则调用 `sendFeishuTextMessage` 把内容以 `【AgentName】\n<content>` 格式发回对应飞书群。

**挂载点**：`src/lib/live-room-delivery.ts`
在 agent 写完 `replyMessage`（`postLiveRoomMessage`）之后，
用 `void relayAgentReplyToFeishu(...).catch(...)` fire-and-forget 触发回传。

**涉及文件**：
- `src/lib/feishu-relay.ts`（新建）
- `src/lib/live-room-delivery.ts`（第 2 行 import，第 1029 行调用）

---

### 2. 普通消息 → Live Room 自动中继（non-command relay）

**问题**：已绑定飞书会话的群里，用户发普通消息（不带 `/ap` 前缀），消息被丢弃。

**方案**：在 `src/lib/feishu-live-room.ts` 新增：
```typescript
tryRelayNonCommandToLiveRoom({ context, content }) → Promise<boolean>
```
逻辑：通过 `scopeKey` 查 binding，若存在则调用 `postFeishuMessageToBoundLiveRoom`
将消息写入 live room 并触发 agent 回复，返回 `true`；无 binding 则返回 `false`。

**挂载点（两处）**：
1. `src/lib/feishu-long-connection.ts`：在 `parseFeishuCommand` 返回 null 时调用
2. `src/app/api/feishu/webhook/route.ts`：同上，非指令时先尝试 relay

两处都是 `parseFeishuCommand === null` 的分支，替换掉原来的直接 ignore/return。

---

### 3. 飞书直接调用 SSH Harness（`/ap hosts` 和 `/ap run`）

**问题**：没有从飞书直接调用远端 harness 的指令，只能通过 live room 间接触发。

**新增 Feishu 指令**（`src/lib/feishu.ts`）：

#### `/ap hosts`
列出所有已注册 SSH 主机，格式：
```
🟢 MyServer [abc12345]
  ubuntu@192.168.1.10:22 (wireguard)
  harnesses: codex, claude
```

#### `/ap run --host=<id|label> --harness=<codex|claude> <prompt>`
- 按 ID、8位后缀、label（大小写不敏感、含子串匹配）定位主机
- 检查主机是否支持该 harness
- 解密私钥，调用 `executeRemoteSshTask()` 直接 SSH 执行
- 超时 5 分钟，返回输出及 Session ID（可后续续接）
- **完全不经过任何 Gateway**，直连 SSH

**类型更新**：
- `ParsedFeishuCommand.command` 增加 `'hosts' | 'run'`
- 指令白名单数组增加 `'hosts'`、`'run'`
- `/ap help` 文本同步更新

---

## 当前已知问题：飞书不响应（待调试）

用户反馈部署后飞书完全无响应，尚未定位根因。

**可能方向**：

1. **长连接模式 vs Webhook 模式**
   - 检查 `FEISHU_CONNECTION_MODE` 环境变量（`long_connection` / `webhook`）
   - 长连接启动失败会导致完全静默

2. **飞书 BOT 环境变量**
   - `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_BOT_OPEN_ID`
   - `FEISHU_ENCRYPT_KEY` / `FEISHU_VERIFICATION_TOKEN`

3. **Standalone 运行时是否启动**
   - 检查 `src/lib/feishu-runtime-status.ts` 写入的状态文件
   - 查看服务日志中是否有 `[feishu-lc]` 前缀的输出

4. **新代码 Import 引入的问题**
   - `feishu-long-connection.ts` 新增了对 `feishu-live-room.ts` 的 import
   - `feishu-live-room.ts` 已有对 `live-room-delivery.ts` 的 import
   - 若模块加载时有 side effect 错误，会导致长连接初始化失败
   - 建议先在日志里确认 `[feishu-lc] starting...` 是否出现

5. **Webhook 模式下的调试**
   - 在 `POST /api/feishu/webhook` 路由里加临时日志确认请求是否到达
   - 检查飞书开放平台的事件订阅配置和回调 URL 是否正确

---

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/lib/feishu-relay.ts` | 新建 | agent reply → Feishu 回传核心逻辑 |
| `src/lib/feishu-live-room.ts` | 修改 | 新增 `tryRelayNonCommandToLiveRoom` |
| `src/lib/live-room-delivery.ts` | 修改 | 引入并调用 `relayAgentReplyToFeishu` |
| `src/lib/feishu.ts` | 修改 | 新增 `hosts`、`run` 指令及解析支持 |
| `src/lib/feishu-long-connection.ts` | 修改 | 非指令消息走 relay 分支 |
| `src/app/api/feishu/webhook/route.ts` | 修改 | 非指令消息走 relay 分支 |

---

## 下一步优先级

1. **调试飞书不响应问题**（当前阻塞）
2. 验证 agent reply → Feishu 回传（需要先解决不响应）
3. 测试 `/ap hosts` 和 `/ap run` 指令
4. 评估 `/ap run` 在 webhook 模式下的超时问题（长任务建议改为异步 + 后续消息推送）