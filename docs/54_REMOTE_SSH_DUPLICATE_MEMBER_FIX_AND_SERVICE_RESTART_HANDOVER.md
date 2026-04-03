# 54 远端 SSH 成员重复判断修复与服务重启问题交接文档

## 日期
2026-04-03

---

## 一、Bug 修复：同类型多个 SSH 主机无法加入同一房间

### 问题描述

当房间里已有一个 `remote_ssh` + `claude` 的成员（如 TX-server Claude），
再尝试添加另一台 `remote_ssh` + `claude` 的主机（如 hk-vision Claude）时，
`/ap add` 始终返回 `已添加 0 个成员`，成员列表里不出现新主机。

### 根本原因

`feishu-live-room.ts` 中 `addAgentsToLiveRoom` 的重复成员检查逻辑有缺陷：

```typescript
// 旧逻辑（有问题）
member.gatewayId ===
  (agent.backend === 'gateway_openclaw'
    ? (agent.gatewayId === 'platform-local' ? null : agent.gatewayId)
    : null)   // ← remote_ssh 统一比较 null，导致所有 SSH claude 都视为同一个
```

对于 `remote_ssh` 后端，成员行里的 `gatewayId` 字段存的是 `null`，
真正的主机 ID 被编码到 `roleLabel` 字段里（格式：`claude __remote_host__:<hostId>`）。
旧逻辑不区分 roleLabel，所以 TX-server Claude 和 hk-vision Claude 被误判为同一个成员。

### 修复方案

引入 `extractRemoteHostIdFromRoleLabel`，在 `remote_ssh` 时从 roleLabel 里取出主机 ID 进行比较：

```typescript
// 新逻辑
const existing = existingMembers.find((member) => {
  if (member.agentRecordId !== (agent.agentRecordId || null)) return false;
  if (member.backend !== agent.backend) return false;
  if (member.harnessType !== agent.harnessType) return false;
  if (member.runtimeAgentId !== (agent.runtimeAgentId || null)) return false;
  if (agent.backend === 'remote_ssh') {
    return extractRemoteHostIdFromRoleLabel(member.roleLabel) === agent.gatewayId;
  }
  return member.gatewayId === (agent.gatewayId === 'platform-local' ? null : agent.gatewayId);
});
```

**涉及文件**：`src/lib/feishu-live-room.ts`

---

## 二、移除重复的 Feishu 回传实现

### 问题描述

Agent 在 live room 回复后，飞书收到两条相同内容的消息：
- `TX-server Claude:\n<内容>` — 来自已有的 `feishu-live-room-relay.ts`（在 `postLiveRoomMessage` 里触发）
- `【TX-server Claude】\n<内容>` — 来自本次新增的 `feishu-relay.ts`（在 `live-room-delivery.ts` 里触发）

### 修复方案

- 删除新增的 `src/lib/feishu-relay.ts`
- 移除 `live-room-delivery.ts` 里对应的 import 和调用
- 保留已有的 `feishu-live-room-relay.ts`（挂在 `postLiveRoomMessage` 里，格式为 `<name>:\n<内容>`）

---

## 三、nohup 服务重启问题说明

### 为什么经常需要重启 feishu:runtime？

在本项目的开发阶段，以下几种情况会导致 feishu runtime 失效，需要手动重启：

| 原因 | 说明 |
|------|------|
| **代码改动** | `npm run feishu:runtime` 用 `ts-node` 加载 TypeScript，启动时编译一次后不会热重载。修改了 `src/lib/feishu*.ts` 等文件后，必须重启才能生效 |
| **Feishu WebSocket 断连** | 飞书长连接偶尔会断开（网络抖动、服务端重启等），SDK 有内置重连，但偶发情况下重连失败会导致进程挂起 |
| **未处理异常** | TypeScript 模块加载或运行时抛出未捕获异常时，进程会退出（`process.exit(1)`） |
| **SQLite 锁** | 多进程同时写 SQLite 偶发锁超时，导致异步操作 reject，可能引发连锁错误 |
| **nohup 进程残留** | 上一次 nohup 进程未正常退出时，`pkill` 有时杀不干净（PID 已变），需要用 `ps aux | grep feishu` 确认后手动 `kill -9` |

### 重启标准流程

```bash
# 1. 确认当前 PID
ps aux | grep "feishu-standalone" | grep -v grep

# 2. 强制停止
kill -9 <pid>
sleep 2

# 3. 确认已停止
ps aux | grep "feishu-standalone" | grep -v grep

# 4. 重新启动
cd /data1/code/agent-platform-v2
nohup npm run feishu:runtime > logs/feishu.log 2>&1 &

# 5. 确认启动成功
sleep 6 && tail -4 logs/feishu.log
# 期望看到：[ws] ws client ready
```

### 判断是否需要重启的快速方法

```bash
tail -20 logs/feishu.log | grep -E "error|Error|ws client ready|failed"
```

- 看到 `ws client ready` → 正常运行中
- 看到 `error` / `failed` / 长时间无新日志 → 需要重启

### 未来改进建议

- 使用 `pm2` 管理进程，自动重启并记录日志：
  ```bash
  pm2 start npm --name "feishu-runtime" -- run feishu:runtime
  pm2 start npm --name "next-dev" -- run dev
  pm2 save
  ```
- 或编写 systemd service 实现开机自启和崩溃自动重启

---

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/lib/feishu-live-room.ts` | 修改 | 修复 remote_ssh 重复成员判断，引入 extractRemoteHostIdFromRoleLabel |
| `src/lib/feishu-relay.ts` | 删除 | 与已有 feishu-live-room-relay.ts 重复，造成双重回传 |
| `src/lib/live-room-delivery.ts` | 修改 | 移除对 feishu-relay.ts 的 import 和调用 |
