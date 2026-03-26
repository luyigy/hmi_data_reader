# 35 ACPX Live Room Async Reply Status And SSH Slowness Handover

## 日期
2026-03-25

## 当前结论

`Live Room` 本轮已经完成几项关键修复：

1. 发送消息不再同步阻塞等待 agent 全部回复完成
2. 页面现在会显示 pending reply 状态，而不是单纯卡在 `发送中...`
3. pending reply 展示已做去重，不再把同一 agent 重复刷成一串名字
4. 页面支持区分：
   - 仍在执行
   - 等待过久，可能卡住
5. 聊天历史区滚动时，不会再被自动强行拖回底部
6. notice / pending summary 横幅现在可手动关闭

但仍有一个未闭环问题：
- `remote_ssh` agent，尤其 `TX-server Claude`，回复速度仍明显慢于本地 agent
- 当前证据说明它不只是“前端慢”，而是远端执行链路本身可能慢 / 堵 / 偶发卡死

## 本轮完成的改动

### 1. 发送改为异步触发 auto reply

文件：
- [messages route](/data1/code/agent-platform-v2/src/app/api/live-rooms/[id]/messages/route.ts)

原来：
- `POST /api/live-rooms/[id]/messages`
- 会 `await triggerLiveRoomMessageReplies(...)`
- 导致按钮长时间停在 `发送中...`

现在：
- 改为后台触发，不再等待完整 agent 回复链路
- API 会尽快返回用户消息

结果：
- 用户发送体验显著改善

### 2. room detail 增加 pending reply 信息

文件：
- [live-room.ts](/data1/code/agent-platform-v2/src/lib/live-room.ts)
- [room route](/data1/code/agent-platform-v2/src/app/api/live-rooms/[id]/route.ts)
- [types](/data1/code/agent-platform-v2/src/types/index.ts)

当前 room payload 已包含：
- `pendingReplyCount`
- `pendingReplyTargetNames`
- `pendingReplies[]`

其中 `pendingReplies[]` 现在是**按 member 去重后的聚合结果**，包含：
- `memberId`
- `displayName`
- `pendingCount`
- `oldestPendingAt`
- `newestPendingAt`
- `newestPendingAgeSeconds`
- `lastProgressAt`
- `lastProgressAgeSeconds`
- `progressLabel`
- `status`

### 3. pending 状态已不再只是“名字重复”

之前用户会看到类似：
- `TX-server Claude、TX-server Claude、TX-server Claude`

现在会显示为：
- `TX-server Claude x4`

并附带状态：
- `正在执行`
- `等待过久，可能卡住`

### 4. 对 remote SSH 增加了粗粒度进度埋点

文件：
- [ssh-executor.ts](/data1/code/agent-platform-v2/src/lib/remote-harness/ssh-executor.ts)
- [live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts)

已增加的进度事件：
- `ssh_spawned`
- `remote_command_started`
- `first_stdout`
- `first_stderr`
- `streaming_output`
- `completed`

这些进度不会单独建表，而是临时写入 `LiveRoomMemberSession`：
- `lastHeartbeatAt`
- `lastError = progress:...`

然后在 room pending summary 里转成用户可读状态。

### 5. 滚动体验已修复

文件：
- [LiveRoomWorkspace.tsx](/data1/code/agent-platform-v2/src/components/live-room/LiveRoomWorkspace.tsx)

原来：
- 只要 `messages` 更新，就强制滚到底

现在：
- 只有用户本来就在底部附近时，才自动跟随新消息
- 如果用户主动往上滚看历史，不会被拉回底部

### 6. 横幅可关闭

文件：
- [LiveRoomWorkspace.tsx](/data1/code/agent-platform-v2/src/components/live-room/LiveRoomWorkspace.tsx)

目前以下横幅都可关闭：
- 绿色发送 notice
- 蓝色 pending summary

这是纯前端 dismiss，不会修改底层真实状态。

## 当前用户体感

用户已经确认以下体验改善可见：

- 发送后不再长时间卡在 `发送中...`
- room 中能看到类似：
  - `消息已发送，这条消息会优先按 mention 路由给 Platform Local Codex。当前正在等待 TX-server Claude 回复。`
  - `TX-server Claude x4：正在执行（39s）。页面会轻量自动刷新。`

说明：
- async send 改动已经生效
- pending summary 改动也已经生效

## 当前仍未解决的问题

### 1. TX-server Claude 依然偏慢

从数据库可看到：

- 有些 remote SSH delivery 能在几十秒内完成
- 例如：
  - `21:34:02 -> 21:34:33`，约 31 秒
- 也有失败案例：
  - `Remote SSH execution timed out after 600000ms`
- 同时还存在旧的 `pending` 残留行

这说明问题不像“单纯网络慢”那么简单，更像是以下几类混合：
- remote host 上 harness 执行本身慢
- 某些任务在远端阻塞
- 某些 pending delivery 没有被正确清理
- 远端 agent 串行排队，导致新消息后面的 delivery 堆积

### 2. 仍存在 stale pending rows

虽然 UI 已做 dedupe，
但数据库里仍然可能残留历史 `pending` 行。

这会造成：
- pending count 偏大
- UI 看起来像“同一个 agent 一直有很多未完成任务”

当前 UI 已尽量缓解，但**数据层并未真正清理旧 pending**。

### 3. socket / polling 临时隔离开关仍然保留

文件：
- [LiveRoomWorkspace.tsx](/data1/code/agent-platform-v2/src/components/live-room/LiveRoomWorkspace.tsx)

仍有：

```ts
const DISABLE_LIVE_ROOM_SOCKET_AND_POLLING = true;
```

当前依赖的是：
- pending reply 驱动的轻量 background refresh

也就是说：
- 实时更新机制目前不是原始 socket 方案
- 而是“只在有 pending reply 时做轻轮询”

## 推荐下一位 agent 的排查顺序

### Step 1. 重点排 remote SSH 慢在哪一段

优先看 [ssh-executor.ts](/data1/code/agent-platform-v2/src/lib/remote-harness/ssh-executor.ts) 新增的进度埋点是否在 UI 上按预期刷新。

要验证：
1. 是否能看到 `SSH connecting`
2. 是否能看到 `remote command started`
3. 是否在进入 harness 后长时间没有 `stdout/stderr`
4. 是否 progress 长时间不变

如果某一阶段卡住，就可以更明确判断：
- SSH 建连慢
- 远端 shell 起命令慢
- Claude CLI 本身慢
- 远端输出回传慢

### Step 2. 处理 stale pending delivery

建议排查 `LiveRoomDelivery`：
- 哪些 pending 已经不可能再完成
- 是否应在一定条件下自动标记为 `failed` / `fallback`
- 是否应该按 session/activity 清理 superseded 项

否则 UI 再怎么 dedupe，
底层仍然会有“假 pending”。

### Step 3. 评估 remote_ssh 是否要串行限流

当前同一 remote member 可能不断累积 pending。

建议评估：
- 同一 member 是否应该一次只跑一个 active delivery
- 新消息是否应 queue / supersede
- 是否给用户一个“该 agent 忙碌中，后续消息排队”提示

### Step 4. 若要恢复 socket，需谨慎

因为前面已经出现过：
- self-refresh / heavy refresh regression

如果未来要恢复 socket：
- 不要直接回到“消息/updated 事件就全量 refreshSelectedRoom()”
- 应优先保留当前轻量思路

## 本轮提交前状态

本轮代码已经过编译验证：
- `next build` 的编译阶段通过

但整体 build 仍会在 repo 其它历史 ESLint 问题上失败。
这些失败并不是本轮 live-room 代码新增的。

## 当前运行方式

当前开发服务已明确改为后台运行在 `3010`：

- URL:
  - `http://localhost:3010`
- 启动方式：
  - 使用 detached 后台进程运行 `npm run dev`
- 当前日志文件：
  - [nohup.live-room.dev.log](/data1/code/agent-platform-v2/nohup.live-room.dev.log)

本次确认过日志中已出现：
- `Local: http://localhost:3010`
- `Ready in 2.1s`

如果下一位 agent 需要确认当前服务是否还活着，可优先检查：

```bash
ss -ltnp | rg ':3010 '
tail -n 60 /data1/code/agent-platform-v2/nohup.live-room.dev.log
```

注意：
- 当前工作区里可能还存在别的 Next 进程占用其它端口
- 但这份 repo 现在约定使用 `3010`
- 不要再让 `next dev` 自动漂移到 `3004` 之类端口，否则用户容易混淆

## 涉及文件

- [LiveRoomWorkspace.tsx](/data1/code/agent-platform-v2/src/components/live-room/LiveRoomWorkspace.tsx)
- [messages route](/data1/code/agent-platform-v2/src/app/api/live-rooms/[id]/messages/route.ts)
- [room route](/data1/code/agent-platform-v2/src/app/api/live-rooms/[id]/route.ts)
- [live-room.ts](/data1/code/agent-platform-v2/src/lib/live-room.ts)
- [live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts)
- [ssh-executor.ts](/data1/code/agent-platform-v2/src/lib/remote-harness/ssh-executor.ts)
- [types](/data1/code/agent-platform-v2/src/types/index.ts)
