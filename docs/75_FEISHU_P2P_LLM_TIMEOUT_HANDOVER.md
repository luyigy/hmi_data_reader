# 75 Feishu P2P `LLM request timed out` 排查交接

## 问题概述

用户反馈：

- 在 **Feishu P2P 聊天**里和绑定到 Agent Platform 的 bot 对话时，收到类似 **`LLM request timed out`** 的回复。
- 用户明确说明：**这个 bot 不是 Hermes 在用的那个 bot**。

本轮目标：

- 检查本项目相关的两个 user systemd service 日志。
- 判断超时回复到底来自哪里。
- 修复当前仓库内可确认的问题。

---

## 本轮最终结论

### 1. 用户“刚刚发送”的那条 P2P 消息，没有进入当前这个 Agent Platform 实例

这是本轮最重要的结论。

已验证事实：

- `agent-platform-feishu.service` 最近 15 分钟 journal **没有任何新消息处理日志**。
- `agent-platform-dev.service` 最近 15 分钟 journal **只有** `/api/feishu/connection` 健康检查，没有 `/api/feishu/webhook` 请求。
- 当前仓库的 `logs/feishu.log` 里也没有“刚刚那条 P2P 消息”的接收或处理记录。
- 数据库里 `FeishuConversationBinding` / `LiveRoomMessage` 最新记录依然停留在 **2026-04-22**，没有新消息落库。

所以：

- 用户刚发的 P2P 消息 **没有到达本项目当前运行的 Agent Platform Feishu 接入链路**。
- 因此，用户看到的 `LLM request timed out`，**大概率不是当前这个运行中的 Agent Platform 实例返回的**。

换句话说：

- 不是“这条消息已经进入了本项目，然后在本项目里超时”。
- 而是“这条消息根本没进入本项目”。

---

### 2. 当前 `agent-platform-feishu.service` 的长连接运行态本身是不健康的

当前 Feishu runtime 日志持续出现：

- `code: 1000040350`
- `Cannot read properties of undefined (reading 'PingInterval')`
- `unable to connect to the server after trying N times`

并且本地安装的 `@larksuiteoapi/node-sdk` 里可确认：

- `1000040350` 对应的是 **`exceed_conn_limit`**

这说明当前这个 runtime 的 **long_connection 模式没有正常拿到可用连接**，而不是正常稳定地在接收消息。

注意：

- 用户口头说明 Hermes 用的是另一个 bot。
- 本轮没有拿到“这两个 bot 一定不同 app_id / 不同 Feishu 应用”的直接证据。
- 但即使先不讨论 Hermes，**当前这个 Agent Platform 的 Feishu long connection 也是明显不健康的**，这是确定事实。

---

### 3. 仓库内还存在一个“旧 live-room session 被重复复用”的真实缺陷，已修

虽然“刚刚那条 P2P 消息没进当前实例”，但本项目内部确实存在一个会导致旧超时状态反复影响后续回复的问题。

数据库里可见历史 session 存在：

- `lastError = "Codex execution timed out after 600000ms"`

原来的问题是：

- live-room delivery 在真正启动新一轮 ACPX 前，
- 会先把 `LiveRoomMemberSession.lastError` 覆盖成
  `progress:acpx participant running`
- 这样就丢失了“上一次已经 timeout / continuation 已坏”的信号。

后果：

- 某些 stale continuation / stale thread 可能会被继续复用，
- 导致用户感觉“怎么又 timeout / 又坏了”。

这个问题已经在本轮修复。

---

## 已做代码修改

修改文件：

- [src/lib/live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts:578)

### 修复内容

在 `executeLiveRoomReplyViaAcpx(...)` 里新增了一个 **preflight stale-session 检查**：

- 将当前 `LiveRoomMemberSession` 的 `lastError` 传入 ACPX 执行前逻辑。
- 如果当前 session 已经有终结性错误，并且符合：
  - continuation 无效
  - timeout
  - codex stale thread
  - 其他已有 `shouldRetryWithFreshSession(...)` 规则
- 则会：
  1. 标记旧 participant continuation 为 stale
  2. 标记当前 live-room session 为 expired
  3. 直接强制 `useFreshSession: true`

这样下一次真正进入当前代码路径时，不会再优先复用那个已知坏掉的 continuation。

### 关键代码位置

- [src/lib/live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts:578)
- [src/lib/live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts:761)
- [src/lib/live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts:1157)

### 验证

执行过：

```bash
./node_modules/.bin/tsc --noEmit --pretty false
```

通过。

---

## 排查过程中确认过的运行态信息

### systemd 服务

两个关键 user service：

- `agent-platform-dev.service`
- `agent-platform-feishu.service`

检查结果：

- 两者均为 `active`
- `agent-platform-dev.service` 实际监听 `3010`

### 当前 Feishu runtime 状态文件

文件：

- [.runtime/feishu-long-connection.json](/data1/code/agent-platform-v2/.runtime/feishu-long-connection.json:1)

内容显示：

- `mode: "long_connection"`
- `host: "standalone"`
- `status: "running"`

但这只是“进程自报运行中”，**不代表真的成功收到 Feishu 消息**。

实际日志显示它持续连不上。

---

## 数据库里看到的关键信息

### 1. 最新 P2P 绑定

当前能看到的 Agent Platform P2P binding：

- `scopeKey = feishu:p2p:oc_b634823504e29e6220de0cfb5108a216`
- `liveRoomId = cmnd3r8r900003cvx88079wd9`
- `updatedAt = 2026-04-22T06:26:20.000Z`

说明：

- 至少数据库里没有更新到“用户刚刚那次发言”的新时间戳。

### 2. 历史 stale session

曾查到旧 room/session 里存在：

- `lastError = "Codex execution timed out after 600000ms"`

这就是本轮修复要处理的 stale reuse 问题来源。

### 3. 最近 LiveRoomMessage 也没有新消息

最新消息仍停留在历史记录，没有出现用户这次“刚刚在 P2P 发的消息”。

---

## 为什么目前不能证明“当前这个实例就是实际回复用户的那个 bot”

因为当前证据链是这样的：

1. 用户说是在 P2P 聊天里收到了 `LLM request timed out`
2. 但本项目当前实例：
   - 没有收到那条消息
   - 没有 webhook 请求
   - long connection 也没正常接到消息
3. 所以这个回复要么来自：
   - 另一个 Feishu 接收方/实例
   - 另一个 bot/app
   - 或另一个仍在运行但不在当前排查范围内的进程

因此，下一位 agent 不应该默认认为：

- “用户看到的 timeout 一定就是当前 `agent-platform-feishu.service` 处理后返回的”

这个前提当前证据不足。

---

## 建议下一位 agent 的后续排查方向

### 方向 1：先确认用户实际聊天对象，对应哪个 Feishu app / bot

这是当前最值得优先做的事情。

目标：

- 明确用户正在聊天的 P2P bot，到底是不是当前仓库 `.env` / runtime 使用的那个 `FEISHU_APP_ID`

建议做法：

- 直接检查当前 Agent Platform 配置里的：
  - `FEISHU_APP_ID`
  - `FEISHU_BOT_OPEN_ID`
  - `FEISHU_HOME_CHANNEL`
- 再和用户实际正在聊的 bot 身份做比对。

如果不一致：

- 那本仓库的排查方向就要改成“找真正处理该 P2P 消息的实例”。

---

### 方向 2：继续追 long_connection 为什么失效

当前明确看到：

- `1000040350`
- reconnect loop
- `PingInterval` 相关异常

需要下一位 agent判断：

- 是 Feishu 侧连接数限制
- 还是另一个实例/进程占用了同一个 app 的长连接
- 还是 SDK / 启动参数 / 网络代理问题

可继续查的点：

- 当前机器上是否还有其他使用同一 `FEISHU_APP_ID` 的进程
- 是否有另一个 webhook/长连接 consumer 在别的主机上
- Feishu 开发者后台该 app 的订阅方式、长连接状态

---

### 方向 3：如果实际走的是 webhook，而不是 long_connection

本项目 webhook 路径在：

- [src/app/api/feishu/webhook/route.ts](/data1/code/agent-platform-v2/src/app/api/feishu/webhook/route.ts:1)

但本轮没有观察到任何近期 webhook 请求。

如果下一位 agent 怀疑真实流量走 webhook：

- 需要先确认公网 / 内网可达地址
- 确认 Feishu 后台 webhook 配置
- 再看 `agent-platform-dev.service` 日志里是否出现 `/api/feishu/webhook`

---

## 本轮不要忽略的事实

请下一位 agent 不要丢掉下面这几个事实：

1. 用户刚发的 P2P 消息，**当前实例没有接收到**
2. 当前 Feishu runtime **长连接不健康**
3. 当前仓库内部确实有 stale live-room continuation reuse 的缺陷，**已修复**
4. 这次修复只能解决“消息已经进入当前实例之后的 stale continuation 问题”
5. 这次修复 **不能解释** “为什么用户刚刚那条 P2P 消息根本没进入当前实例”

---

## 本轮修改摘要

修改文件：

- [src/lib/live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts:554)

改动效果：

- 如果当前 room session 已带有 timeout / stale continuation 类错误，
- 则下一次回复会直接丢弃旧 continuation，强制 fresh session。

---

## 可直接复述给下一位 agent 的一句话

当前最关键的结论不是“又出现了一个新的 LLM timeout bug”，而是：

**用户刚刚那条 Feishu P2P 消息没有进入当前 Agent Platform 实例；与此同时，仓库内部还存在 stale live-room continuation 复用问题，本轮已修。下一位 agent 应先确认用户实际聊天的 bot/app 是否就是当前实例配置的那个 Feishu app。**
