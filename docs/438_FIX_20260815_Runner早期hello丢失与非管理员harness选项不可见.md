---
doc_type: FIX
doc_status: completed
next_action: none
---

# FIX · Runner 早期 hello 丢失与非管理员 harness 选项不可见

## 问题描述

S04 配对链路（票据→兑换→凭证→WS 连接）打通后，实测仍有两处让"普通用户接入自己的
本地电脑"闭环卡死：

1. **Runner 的 `hello` 帧被静默丢弃**。`handleNodeConnection` 在 `await
   verifyNodeSecret/registerNode/markRemoteNodeMembersOnline` 之后才挂 `message`
   监听；runner 一收到 `welcome` 前的 `open` 就发 `hello`，该帧到达时监听尚未就绪
   → harness/workspace 元数据永远不落库 → 节点在任务/Live Room 的 harness 选项里
   永远不出现（只剩 30s 后的心跳在刷新 lastSeen）。实测确认：立即发的 `hello`
   丢失，延迟 1.5s 发的 `hello` 正常处理。该缺陷源自 `92dfb10`（早于 S04），但
   S04 的"端到端配对"目标使它首次成为阻断项。
2. **`/api/acpx/harness-options` 被划为 admin-only**。普通用户打开任务表单时
   401，看不到任何可选执行端——即使已成功配对自己的电脑。且
   `deriveGatewayHarnessOptions()` 对 RemoteNode 无 owner 过滤，放开路由就必须
   同时做归属过滤，否则普通用户会看到（并尝试执行）别人的节点和平台本地宿主机。

## 修复方案

1. **早期事件缓冲**（`src/lib/remote-node-ws.ts`）：进入
   `handleNodeConnection` 立即挂消息监听，把 setup 等待期间到达的帧入队；异步
   初始化完成后安装真实处理器并回放缓冲帧；close 事件同样记录并在 setup 后补跑
   disconnect。
2. **harness 选项按角色过滤**（`src/lib/acpx/catalog.ts` +
   `src/app/api/acpx/harness-options/route.ts` + `src/lib/auth-routes.ts`）：
   - 路由策略 `admin` → `authenticated`，Route Handler 调用
     `requireCurrentUser` 并把用户传入 catalog；
   - `deriveGatewayHarnessOptions(user)`：非管理员只返回自己名下
     `RemoteNode`（ownerUserId 过滤），不再暴露平台本地、全局 Gateway、共享 SSH
     主机；管理员行为不变（保持全量）；
   - `listLiveRoomCatalogAgents` 改为直接传入 user，删除原来的后置过滤
     （避免先构建全部选项再过滤的中间态）。

## 验证情况

- 新增 `tests/remote-node-ws.test.ts`（`npm run test:remote-node-ws`）：用假
  WebSocket 在 `handleNodeConnection` promise 未决时立即发 `hello`，断言元数据
  最终落库、heartbeat_ack、4001/4003 关闭码。
- 新增 `tests/acpx-harness-options.test.ts`（`npm run test:acpx-harness-options`）：
  普通用户只见自己节点（不见他人/平台节点、不见 platform-local/gateway/ssh 选项），
  管理员可见全部；路由策略断言 `authenticated`。
- 实测（LAN IP `192.168.31.109`）：配对 → runner 免参数重连 → 节点 `online` →
  `/api/acpx/harness-options` 仅返回 `remote-node:hello-920fb0ad / Pi Agent
  Runner` → gateway `POST /run` 实际派发：pi 进程在指定 workspace 启动，
  stdout/stderr 流式回传，`complete` 携带 sessionDir（"No API key" 为测试 HOME
  隔离的预期环境现象，真实远程机由用户自己的 pi 登录态解决）。
- 回归：`test:pairing`、`test:auth-users`、`npx tsc --noEmit`、
  `npm run check:long-files`、`git diff --check` 全部通过。

## 配套环境变更（无代码提交）

- `.env` 新增 `REMOTE_RUNNER_PUBLIC_URL=http://192.168.31.109:3012`（claim 返回
  给 runner 的 WS 地址）。
- Remote Runner Gateway 以 `REMOTE_RUNNER_GATEWAY_HOST=0.0.0.0` 启动于 :3012
  （默认 127.0.0.1 远程机不可达）；后续建议沉淀为 systemd unit。
