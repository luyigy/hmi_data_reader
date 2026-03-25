# 33 ACPX Live Room Refresh / Socket Regression Handover

## 日期
2026-03-25

## 当前状态

本轮在补 `Live Room` 的：
- 编辑
- 归档
- 硬删除
- archived rooms 列表

之后，又为了改善“消息刷新主要靠手动刷新”的体验，
在前端加了：
- socket 初始化
- socket 事件监听
- polling fallback

但结果引入了新的回归：
- 页面会出现“自己在刷新 / 重拉”
- 用户体感明显不对
- 期间还出现过浏览器不断访问：
  - `http://10.0.8.4:3101/api/socket/...`
  - 并报 `ERR_CONNECTION_TIMED_OUT`

到本次交接为止：
- 部分根因已经定位
- 部分代码已经修正
- 但用户仍反馈“refreshing problem remains”

所以这个问题应视为：
- **未完全闭环**

## 问题是如何被引入的

### 第一步：为了解决“消息更新主要靠手动刷新”

在 `src/components/live-room/LiveRoomWorkspace.tsx` 中，
增加了 socket 连接逻辑与 fallback 轮询逻辑。

当前关键代码位置：
- [LiveRoomWorkspace.tsx](/data1/code/agent-platform-v2/src/components/live-room/LiveRoomWorkspace.tsx#L266)
- [LiveRoomWorkspace.tsx](/data1/code/agent-platform-v2/src/components/live-room/LiveRoomWorkspace.tsx#L365)

#### socket 逻辑
- 通过 `getSocketClient()` 获取 socket client
- `ensureSocketServerReady()` 先打 `/api/socket`
- 再 `socket.connect()`
- 监听：
  - `live-room:message`
  - `live-room:updated`
  - `live-room:deleted`

#### polling 逻辑
- 当 `isSocketConnected === false` 时
- 每 5 秒：
  - `refreshRooms()`
  - `refreshSelectedRoom(initialRoomId)`

也就是说，当前仍有 fallback 轮询存在。

### 第二步：页面出现“自己刷新”

一开始的明确回归原因是：

#### 原始回归原因 A
普通消息流转时：
- 后端 `postLiveRoomMessage()` 会：
  - `emitLiveRoomMessage(payload)`
  - `emitLiveRoomUpdated(roomId)`

关键代码：
- [live-room.ts](/data1/code/agent-platform-v2/src/lib/live-room.ts#L470)

而前端最开始对 `live-room:updated` 的处理是：
- 收到一次 `updated`
- 就执行一次整页级别 `refreshSelectedRoom(initialRoomId)`

这会导致：
- 每条消息不仅追加 message
- 还再触发一次完整房间 detail / messages 重拉

这就是页面“像在自己刷新”的第一层原因。

### 第三步：尝试修复 A

已改动：
- `handleRoomUpdated` 不再对当前房间直接调用 `refreshSelectedRoom()`
- 改为只局部更新当前选中 room 的 summary 字段

当前代码：
- [LiveRoomWorkspace.tsx](/data1/code/agent-platform-v2/src/components/live-room/LiveRoomWorkspace.tsx#L282)

这一步理论上已经消除了：
- “每条消息都整页重拉 detail”的问题

## 第二类问题：socket 失败导致 fallback 轮询持续开启

后来又发现，浏览器控制台不断报：

```text
GET http://10.0.8.4:3101/api/socket/?EIO=4&transport=polling...
net::ERR_CONNECTION_TIMED_OUT
```

这会导致：
- socket 一直连不上
- `isSocketConnected` 一直是 `false`
- fallback polling 一直运行
- 页面继续定期 `refreshRooms()` / `refreshSelectedRoom()`

这就是页面仍然“像自己在刷新”的第二层原因。

## 为什么会出现 3101

### 最早原因

最开始 `src/lib/websocket-client.ts` 里有客户端默认端口：
- `DEFAULT_SOCKET_PORT = 3101`

所以如果没有显式配置，
浏览器会默认连：
- `当前 hostname:3101`

### 后来发现的环境变量原因

即使去掉了代码里的硬编码默认值，
项目 `.env` 仍然写着：
- [`.env`](/data1/code/agent-platform-v2/.env#L5) `SOCKET_PORT=3010`
- [`.env`](/data1/code/agent-platform-v2/.env#L6) `NEXT_PUBLIC_SOCKET_PORT=3010`

更早一版则是：
- `NEXT_PUBLIC_SOCKET_PORT=3101`

而 `NEXT_PUBLIC_*` 会被编译进前端 bundle。

### 当前客户端逻辑

现在 `src/lib/websocket-client.ts` 已进一步收紧为：
- 只认 `NEXT_PUBLIC_SOCKET_URL`
- 否则直接走 `window.location.origin`

当前代码：
- [websocket-client.ts](/data1/code/agent-platform-v2/src/lib/websocket-client.ts#L23)

也就是说：
- **当前代码已经不再使用 `NEXT_PUBLIC_SOCKET_PORT`**

## 但为什么用户仍可能看到 3101

如果在当前代码下，
浏览器仍继续请求：
- `10.0.8.4:3101/api/socket/...`

那最可能的原因不是“现在代码还在这么写”，
而是下面几种之一：

### 1. 前端仍在跑旧 bundle

这是目前最值得优先怀疑的点。

因为：
- `NEXT_PUBLIC_*` 是编译进前端的
- 客户端模块也会被 dev/build 打包缓存
- 如果 dev server 没重启
- 或浏览器/tab 仍持有旧 HMR bundle
- 就可能继续使用旧的 socket baseUrl 逻辑

### 2. 页面仍是旧标签页 / 旧 session

即使代码已改，
某些旧 tab 里的单例：
- `clientSocket`

已经按旧地址初始化过，
就会继续尝试连旧地址。

### 3. 实际运行的并不是当前工作区代码

这类问题在多进程 / 多终端开发时也要警惕：
- 编辑的是当前 repo
- 但 3010 上跑的是另一个旧进程

## 本轮已经做过的修复

### 已做 1. 去掉客户端默认 3101
- 文件：
  - [websocket-client.ts](/data1/code/agent-platform-v2/src/lib/websocket-client.ts)

### 已做 2. connect 前先打 `/api/socket`
- 目的：
  - 确保 socket server 先初始化

### 已做 3. fallback polling 只在 socket disconnected 时启用
- 不是一直轮询
- 但前提是 `isSocketConnected` 能真的变成 `true`

### 已做 4. 去掉 `live-room:updated -> refreshSelectedRoom()` 的整页重拉
- 改成局部 patch 当前 room summary

## 当前残留风险

### 风险 1. fallback polling 仍然过重

即使它只在 socket disconnected 时才启用，
它当前仍然做的是：
- `refreshRooms()`
- `refreshSelectedRoom(initialRoomId)`

这仍然是比较重的。

如果 socket 因任何原因一直不连，
页面就还是会持续重拉。

### 风险 2. 即使 socket 成功，某些路径可能仍触发多余 refresh

当前组件中仍有多处显式调用：
- `refreshSelectedRoom(...)`
- `refreshRooms()`

虽然这不一定是 bug，
但如果和 socket 事件叠加，
仍可能让 UI 有抖动感。

## 推荐下一位 agent 的排查顺序

### Step 1. 先确认浏览器实际跑的是不是新 bundle

用户已说：
- `.env` 改成了 `3010`

但用户仍看到：
- `10.0.8.4:3101/api/socket`

这说明首先要确认：
- 3010 这个前端进程是否已重启
- 浏览器是否 hard reload
- 访问的是否真是当前这份代码对应的 dev server

建议检查：
1. 浏览器 Network 中 `api/socket` 的 host 到底是什么
2. 浏览器 Sources 中 `websocket-client.ts` 编译结果是不是：
   - `process.env.NEXT_PUBLIC_SOCKET_URL || window.location.origin`
3. 当前 3010 进程是不是最新启动的 next dev

### Step 2. 如果仍有 refresh，临时完全关掉 fallback polling 验证

最直接的验证法：
- 暂时注释掉 [LiveRoomWorkspace.tsx](/data1/code/agent-platform-v2/src/components/live-room/LiveRoomWorkspace.tsx#L365) 这段轮询 effect

观察：
- 页面是否还会“自己刷新”

如果注释后不再刷新，
说明剩余问题仍是 polling 驱动。

### Step 3. 如果关闭 polling 后仍抖动，再排查其它主动 refresh 点

重点看：
- `handleSendMessage`
- `handleSaveRoomSettings`
- `handleArchiveRoomById`
- `handleAddMember`
- `handleSetSpeaker`

这些地方很多都会在成功后再：
- `await refreshSelectedRoom(...)`
- `await refreshRooms()`

这在用户主动操作后是合理的，
但若与 socket 事件重叠，
可能产生“双重更新”。

### Step 4. 若 socket 仍不稳定，优先让 socket 连接彻底同源

当前建议最终策略：
- 不使用 `NEXT_PUBLIC_SOCKET_PORT`
- 不依赖单独 socket 端口
- 前端统一连：
  - `window.location.origin`

如果系统最终并不需要独立 socket server，
那可以考虑彻底移除：
- `.env` 中的 `NEXT_PUBLIC_SOCKET_PORT`

以减少误导。

## 本次交接时的关键文件

- [LiveRoomWorkspace.tsx](/data1/code/agent-platform-v2/src/components/live-room/LiveRoomWorkspace.tsx)
- [websocket-client.ts](/data1/code/agent-platform-v2/src/lib/websocket-client.ts)
- [live-room.ts](/data1/code/agent-platform-v2/src/lib/live-room.ts)
- [route.ts](/data1/code/agent-platform-v2/src/app/api/live-rooms/route.ts)
- [route.ts](/data1/code/agent-platform-v2/src/app/api/live-rooms/[id]/route.ts)
- [`.env`](/data1/code/agent-platform-v2/.env)

## 一句话结论

当前最像真实根因的链路是：

1. 为了解决“消息只能手动刷新”
2. 引入 socket + fallback polling
3. socket 一度连错到 `3101`
4. 导致 `isSocketConnected=false`
5. fallback polling 持续生效
6. 页面出现“自己在刷新”的体感

而现在虽然代码已经收紧 socket baseUrl，
但用户仍看到 `3101`，
所以**下一位 agent 最优先要确认的是：浏览器当前到底是不是在跑最新 bundle / 最新 next dev 进程**。
