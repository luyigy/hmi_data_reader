# 72 — Hermes Feishu 集成：Session 鲁棒性学习与改进方向

**日期**：2026-04-18  
**来源仓库**：`/home/hello/.hermes/hermes-agent/` (NousResearch/hermes-agent)  
**重点文件**：`gateway/platforms/feishu.py`（1500+ 行）、`feishu_comment.py`、`feishu_comment_rules.py`

---

## 一、Hermes 的核心设计亮点（我们可以学习的地方）

### 1. 消息去重（跨重启持久化）

Hermes 把已处理的 message_id 持久化到 `~/.hermes/feishu_seen_message_ids.json`，重启后仍有效。

- **缓存大小**：默认 2048 条（可配置）
- **TTL**：24 小时（`_FEISHU_DEDUP_TTL_SECONDS`）
- **检查时机**：每条入站消息先走 `_is_duplicate()` 判断，重复则丢弃
- **维护**：LRU 队列（`_seen_message_order`）+ 时间戳，避免无限增长

**我们的现状**：目前没有持久化的 message_id 去重机制，进程重启后同一条消息可能被二次处理。

---

### 2. 入站事件队列（进程启动期间的消息保全）

飞书 WebSocket 连接往往比业务循环（event loop）更早 ready。Hermes 用一个 **pending inbound queue** 解决这个竞态：

- 所有在 loop 就绪之前到达的事件，放入 `_pending_inbound_events` 队列（上限 1000 条）
- 启动一个 daemon 线程 `_drain_pending_inbound_events()` 等待 loop 就绪（最多等 120s）后回放
- loop 就绪后按序处理，不丢任何消息

**我们的现状**：standalone runtime 启动时有一段窗口期，此期间飞书消息可能丢失或 crash。

---

### 3. 并发 Session 的中断与排队

同一个会话（chat_id + user_id）同时有两条消息时：

- 第二条消息放入 `_pending_messages[session_key]`
- 同时触发 `_active_sessions[session_key].set()` 给正在运行的 session 发中断信号
- 当前 session 结束后，pending 消息自动被 replay

**关键点**：不是直接打断，而是"信号 + 排队"，保证消息不丢失，同时让 agent 有机会优雅结束。

**我们的现状**：飞书 relay 里没有 session 粒度的并发队列，第二条消息到来时行为不确定。

---

### 4. 发送重试 + fallback（消息撤回场景）

`_feishu_send_with_retry()`：
- 最多 3 次重试，指数退避
- **特殊处理**：如果回复失败，错误码是 `230011`（消息已撤回）或 `231003`（消息不存在），自动降级为向 chat 发新消息，而不是报错退出
- 整个重试逻辑对调用方透明

**我们的现状**：`feishu-api.ts` 里的发送没有 fallback 到"新消息"的降级逻辑，消息撤回后 reply 会失败。

---

### 5. WebSocket 重连参数运行时注入

Hermes 在 WS 客户端启动后，通过 `setattr` 动态覆盖 SDK 内部的重连参数：

- `_reconnect_nonce`：默认 30
- `_reconnect_interval`：默认 120s
- `ws_ping_interval` / `ws_ping_timeout`：可配置

关机时显式调用 `setattr(ws_client, "_auto_reconnect", False)` 禁止重连，确保 graceful shutdown 不会自动拉起。

**我们的现状**：飞书 long connection 的重连行为依赖 SDK 默认值，没有显式控制，关机时可能出现重连竞争。

---

### 6. 连接建立重试（`_connect_with_retry`）

- 最多 3 次（`_FEISHU_CONNECT_ATTEMPTS`）
- 指数退避（2^attempt 秒）
- 失败后清理连接状态并 raise，由外层决定是否重试或退出

**我们的现状**：standalone monitor 启动时连接失败即崩溃，没有重试逻辑。

---

### 7. Webhook 速率限制与异常追踪

（Webhook 模式下）：
- 速率限制：每个 `{app_id}:{path}:{remote_ip}` 在 60s 内最多 120 次
- 异常计数器：同 IP 连续报错超过 25 次打 WARNING，TTL 6 小时
- 限制字典上限 4096 条，满时主动清理过期项

这部分我们暂时不用（long_connection 模式），但 webhook 模式切换时可参考。

---

### 8. 文本批处理防抖（消息分片合并）

飞书客户端对长消息（>4000 字）会自动拆分发送。Hermes 用 debounce 批处理：
- 同一会话的消息放入 `_pending_text_batches[key]`
- 0.6s 内没有新消息才 flush，或达到 8 条 / 4000 字上限强制 flush
- 合并后作为一整条消息交给 agent

**我们的现状**：没有消息分片合并逻辑，用户发的长消息可能被拆成两条各自触发独立的 session。

---

### 9. "应答表情"确认收到（ACK Emoji）

Hermes 收到消息后，立即给该消息加一个 "OK" 表情，作为"已收到"的视觉反馈。
- 基于飞书 Drive v2 comment reaction API
- 记录 `_sent_message_ids_to_chat`（LRU，上限 512 条）用于路由 reaction 事件

**我们的现状**：没有 ACK 表情，用户无法确认消息是否被处理（打字中提示是现有替代）。

---

## 二、我们 Session 鲁棒性的当前短板（对照表）

| 问题 | Hermes 做法 | 我们现状 | 优先级 |
|------|------------|---------|--------|
| 重启后重复处理同一消息 | 持久化 dedup JSON，TTL 24h | 无持久化 dedup | 🔴 高 |
| 启动窗口期消息丢失 | pending inbound queue + drain thread | 无 | 🔴 高 |
| 并发消息打断 session | 中断信号 + 排队 replay | 无 session 粒度排队 | 🔴 高 |
| 发送失败无降级 | reply 失败自动降级为新消息 | 无 fallback | 🟡 中 |
| WS 重连不可控 | 运行时覆盖重连参数 | 依赖 SDK 默认 | 🟡 中 |
| 连接启动无重试 | 3 次指数退避重试 | 失败即崩溃 | 🟡 中 |
| 长消息分片合并 | 0.6s debounce 批处理 | 无合并，逐条触发 | 🟡 中 |
| 收到消息无视觉确认 | ACK 表情 | 打字中（typing indicator） | 🟢 低 |

---

## 三、建议的改进方向（按优先级）

### P0 — 启动窗口期 & 重启去重

**目标**：进程重启期间不丢消息，不重复处理消息。

1. **持久化 message_id dedup**  
   在 `src/lib/feishu.ts` 或 standalone monitor 里维护一个 `feishu_seen_message_ids.json`（同路径约定 `~/.hermes/` 或我们的 `data/`），每次处理前先检查，处理后写入，重启后加载。

2. **pending inbound 队列**  
   standalone monitor（`scripts/feishu-standalone-monitor.js`）启动时，WS 连接可能比 HTTP API 服务（Next.js）更早接到消息。应在 WS ready 后先缓冲消息，等 API 服务确认可用（health check）后再 flush。

### P1 — 并发消息排队

**目标**：同一个 chat session 同时收到两条消息时，第二条等第一条的 agent 跑完再处理，而不是互相干扰。

在 `src/lib/feishu.ts` 的消息处理入口，维护 `activeSessions: Map<string, Promise>` + `pendingMessages: Map<string, Message[]>`，session 结束后自动 drain pending。

### P2 — 发送重试 & fallback

**目标**：reply 失败时不报错退出，而是尝试发新消息。

在 `src/lib/feishu-api.ts` 的发送函数里，包装为最多 3 次指数退避重试，若 reply API 返回"消息不存在"错误，降级为 `sendMessage` 到同一 chat_id。

### P3 — 连接重试 & graceful shutdown

**目标**：standalone monitor 启动时连接失败不崩溃，停止时 WS 不自动重连。

在 `scripts/feishu-standalone-monitor.js` 的连接逻辑里加 3 次重试，以及 SIGTERM 收到后先禁止重连再断开。

---

## 四、不建议搬过来的（暂时）

- **Webhook 速率限制**：我们用 long_connection 模式，暂不需要
- **ACK Emoji**：typing indicator 已承担这个角色，ACK 表情会与之冲突，先跳过
- **评论系统**（feishu_comment.py）：我们暂无飞书 Docs 评论集成需求

---

## 五、下一步行动

1. 实现 **持久化 dedup**（P0，改动范围小，收益大）
2. 实现 **pending inbound 队列**（P0，改 standalone monitor 的启动逻辑）
3. 讨论 **并发 session 排队**方案（P1，需要在 feishu.ts 消息入口做结构性改动）

以上三项完成后，session 鲁棒性将与 Hermes 生产级实现基本对齐。
