# 34 ACPX Live Room Send Blocking And Delivery Flow Handover

## 日期
2026-03-25

## 当前结论

当前 `Live Room` 里“发送中...”卡很久，不是前端按钮自身的问题，核心原因是：

1. 前端 `handleSendMessage()` 会一直等待 `POST /api/live-rooms/[id]/messages` 返回
2. 该 API 在写入用户消息后，会同步 `await triggerLiveRoomMessageReplies(...)`
3. `triggerLiveRoomMessageReplies()` 会同步执行真实 agent 回复
4. agent 回复过程中还可能继续触发 chained mention，形成多跳串行等待
5. 如果其中任何一步走到 `remote_ssh`，当前超时是 `10 分钟`

所以用户看到的体感就是：
- 按钮变成 `发送中...`
- 输入框长时间不可用
- 页面像“卡住”
- 直到整个 agent 链条执行完，HTTP 才返回

这和 socket / polling 是否开启是两层问题：
- socket / polling 影响“回复何时出现在页面”
- 但“发送中...”长时间不结束，根因是 API 本身同步等待 agent 执行完成

## 关键代码路径

### 1. 前端发送入口

文件：
- [LiveRoomWorkspace.tsx](/data1/code/agent-platform-v2/src/components/live-room/LiveRoomWorkspace.tsx#L445)

行为：
- 点击发送后 `setIsSending(true)`
- `await fetch('/api/live-rooms/${selectedRoom.id}/messages', ...)`
- 只有这个请求返回后才会 `setIsSending(false)`

### 2. API 路由

文件：
- [messages route](/data1/code/agent-platform-v2/src/app/api/live-rooms/[id]/messages/route.ts#L108)

当前关键逻辑：
- 先 `postLiveRoomMessage(...)` 写入用户消息
- 然后：

```ts
if (autoReply) {
  await triggerLiveRoomMessageReplies({
    roomId: params.id,
    roomMessageId: message.id,
    requestedTargetMemberId: resolvedTargetMemberId || null,
  });
}
```

也就是说：
- API 不是“写入消息后立即返回”
- 而是“等 agent 回复流程也跑完再返回”

### 3. Delivery 层

文件：
- [live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts#L597)

当前逻辑：
- 先算本条消息该由谁回复
- 然后串行：
  - `await triggerLiveRoomAgentReply(...)`
- 如果是 `@all`
  - 会循环多个成员，逐个 `await`
- 如果 agent 回复里又 mention 了别人
  - `triggerLiveRoomAgentReply()` 里还会递归再 `await` 下一跳

### 4. 真正执行 agent 的地方

文件：
- [live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts#L433)
- [live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts#L449)
- [live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts#L463)

后端会根据 member backend 执行不同路径：
- `gateway_openclaw` -> `createOpenClawResponse(...)`
- `remote_ssh` -> `executeRemoteSshTask(...)`
- `platform_local` -> `executeCodexTask(...)` / `resumeCodexSession(...)`

当前总超时：
- [live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts#L18)
- `DEFAULT_TIMEOUT_MS = 10 * 60 * 1000`

所以只要目标成员是 `remote_ssh` 或 agent 本身执行慢，
前端发送按钮就会一直卡住。

## 本地数据库中已经看到的证据

当前房间成员：
- `Platform Local Codex`
  - backend: `platform_local`
  - harness: `codex`
- `TX-server Claude`
  - backend: `remote_ssh`
  - harness: `claude`

数据库里已经出现过：
- `LiveRoomDelivery.failed`
- `fallbackReason = Remote SSH execution timed out after 600000ms`

并且最新一轮消息链路里可以看到：
1. 用户先 `@TX-server Claude`
2. `TX-server Claude` 回复后又 mention 了 `@Platform Local Codex`
3. `Platform Local Codex` 回复后又 mention 了 `@TX-server Claude`
4. 因此 delivery 又回到了 `remote_ssh`

这说明本次“卡住”的真实形态很可能是：
- 不是单跳等待
- 而是多跳 chained mention 把一次发送扩展成了更长的串行执行链

## 为什么“收不到 agent 消息”

要分成两种情况：

### 情况 A. 发送请求本身还没返回

这种情况下：
- 前端还在 `await fetch(...)`
- 按钮保持 `发送中...`
- 当前轮 agent 回复尚未全部完成

此时不是“前端没显示”，而是后端整条链路还没结束。

### 情况 B. 就算后端已异步完成，当前页面的实时更新也可能失效

上一轮为了定位“self-refresh”问题，
目前在 [LiveRoomWorkspace.tsx](/data1/code/agent-platform-v2/src/components/live-room/LiveRoomWorkspace.tsx#L25) 加了：

```ts
const DISABLE_LIVE_ROOM_SOCKET_AND_POLLING = true;
```

它会直接短路：
- socket effect
- polling effect

因此如果后续把发送改成“立即返回 + 后台异步回复”，
那当前页面也**不会自动收到新消息**，
除非：
- 手动刷新
- 或重新打开 socket / polling

## 关于控制台 warning

warning 来源：
- [encryption.ts](/data1/code/agent-platform-v2/src/lib/encryption.ts#L23)

内容：
- `OPENCLAW_ENCRYPTION_KEY not set, using default key (INSECURE)`

它表示：
- OpenClaw 相关 token 加密正在用开发默认 key
- 这是安全配置问题
- **不是这次发送卡住的直接根因**

除非当前房间成员实际走的是 `gateway_openclaw`，
否则它和 `remote_ssh` / `platform_local` 发送阻塞不是同一问题。

## 推荐下一步

### 方案 1. 把 auto reply 改成异步触发

目标：
- API 在写入用户消息后立刻返回
- 不再 `await triggerLiveRoomMessageReplies(...)`

收益：
- `发送中...` 很快结束
- 输入框立即可继续使用

代价：
- 必须恢复实时更新机制，或者补一个轻量轮询
- 否则 agent 回复不会自动出现在页面

### 方案 2. 限制 chained mention 的同步扩散

当前一次回复可能扩展成：
- user -> remote agent -> local agent -> remote agent

可考虑：
- 用户首条消息只触发首个目标 agent
- 二跳 mention 改成后台异步
- 或 live room 中默认关闭 chained mention

### 方案 3. 给 delivery 增加明确状态提示

例如：
- “消息已投递，等待 TX-server Claude 回复”
- “TX-server Claude 回复后又转给 Platform Local Codex”
- “当前卡在 Remote SSH 执行”

这样即使仍是同步，也不会像“页面无响应”。

## 当前工作区状态提醒

本轮未修复发送阻塞，只完成了定位与证据确认。

当前仍保留上轮的临时隔离开关：
- [LiveRoomWorkspace.tsx](/data1/code/agent-platform-v2/src/components/live-room/LiveRoomWorkspace.tsx#L25)

所以如果下一位 agent 要继续处理“消息不自动出现”，
请先确认：
1. 是否保留该开关继续排查
2. 是否先把发送路径改成异步
3. 然后再恢复更轻量的实时同步机制
