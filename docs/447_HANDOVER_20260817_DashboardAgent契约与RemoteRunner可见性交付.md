---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/444_PLAN_20260817_LiveRoom远程执行超时Runner连接与Dashboard可见性修复.md
slice: S03
plan_progress: complete
---

# HANDOVER · DashboardAgent契约与RemoteRunner可见性交付

## 完成内容

1. **固定 `/api/agents` 响应契约**：每个 Agent 新增卡片标题所需的 `name`（与 `displayName`
   同值）和 ISO `lastHeartbeat`；保留 `displayName`/`originalName` 等既有消费者字段，
   `/agents`、`/tasks`、创建表单不受影响。`capabilities` 解析加固为始终返回字符串数组
   （上游未上报时为 `[]`，不伪造默认值），并新增 `storedStatus` 暴露数据库原始状态。
2. **远程 Gateway Agent 有效状态**：新增 `src/lib/agent-effective-status.ts`，
   `computeEffectiveAgentStatus` 按“已存状态 + 心跳新鲜度”共同计算——远程 Gateway Agent
   的 `online` 状态要求 `lastHeartbeat` 在 30 秒心跳 × 3 周期 = 90 秒阈值内（阈值以常量
   `REMOTE_AGENT_OFFLINE_THRESHOLD_MS` 固定并在测试锁定），陈旧/缺失心跳读取为 offline；
   Platform Local 无真实心跳源，保留已存状态语义，Dashboard GET 不伪造健康检查。
3. **Dashboard 缺失数据展示**：新增 `src/lib/dashboard-display.ts` 纯展示助手，
   `AgentCard` 心跳缺失显示“从未心跳”、不可解析显示“未知”（不再渲染 `Invalid Date`），
   空 capabilities 显示“未上报”（不再渲染空白区域），标题兜底“未命名 Agent”。
4. **Remote Runners 可见性**：`RemoteNodeInfo` 扩展非敏感 metadata（`harnesses`、
   `workspace`，元数据损坏时降级为空值），`/api/remote-nodes` 保持既有鉴权与 owner
   过滤语义，绝不返回 secret/secretHash。新增 Dashboard 独立 “Remote Runners” 状态区
   （`RemoteRunnersPanel`），直接请求现有 `/api/remote-nodes`，展示 name、online/offline、
   host、lastSeen（`lastSeen=null` 显示“从未连接”）、harnesses 与 workspace，与 Gateway
   Agent 数据模型不合并；随 Dashboard refreshKey 刷新。
5. **验收（本机 shaw-pi dev 服务）**：`/api/agents` 26 个 Agent 全部返回非空 `name` 与
   ISO `lastHeartbeat`；陈旧远程 Gateway Agent（心跳 2026-03）由 stored online 正确降为
   offline，Platform Local 保持 online；`/api/remote-nodes` 返回 `ww-ce250bc4`
   （offline、lastSeen=null → “从未连接”），未认证请求 401。Playwright 浏览器验收全绿：
   无 `Invalid Date`、无空标题、无陈旧远程 Agent 显示“在线”、空能力显示“未上报”、
   Remote Runners 区正确显示目标节点。

## 修改文件

- `src/lib/agent-effective-status.ts`（新增）
- `src/lib/dashboard-display.ts`（新增）
- `src/app/api/agents/route.ts`
- `src/lib/remote-node-registry.ts`
- `src/components/dashboard/AgentCard.tsx`
- `src/components/dashboard/RemoteRunnersPanel.tsx`（新增）
- `src/components/dashboard/index.ts`
- `src/app/page.tsx`
- `src/types/index.ts`
- `tests/dashboard-agent-visibility.test.ts`（新增）
- `package.json`（新增 `test:dashboard-visibility`）

## 验证

- `npm run test:dashboard-visibility`：契约测试覆盖——90 秒阈值常量（30s×3）、远程 Agent
  新鲜/陈旧/恰好阈值/缺失心跳、Platform Local 陈旧心跳保持 online、非 online 状态透传、
  未知状态归一；缺失/不可解析心跳与 lastSeen 的展示文案（从未心跳/未知/从未连接/未上报）；
  `/api/agents` 逐 Agent 断言非空 `name`、ISO `lastHeartbeat`、capabilities 数组、
  `storedStatus`，陈旧远程 Agent 读取 offline、空 capabilities 保持 `[]` 不伪造；
  `/api/remote-nodes` 覆盖 online/offline/从未连接（lastSeen=null）/metadata 损坏降级、
  响应不含 secret/hash、未认证 401、admin 不过滤而 user 按 `ownerUserId` 过滤；
  组件接线静态断言（AgentCard 经助手渲染心跳、空能力显示未上报、Remote Runners 区挂载）。
- 回归：`test:remote-node-ws`、`test:pairing`、`test:remote-runner-deployment`、
  `test:acpx-harness-options` 通过。
- `npx tsc --noEmit`、`npm run build`、`npm run check:long-files`、`git diff --check` 通过。
- 浏览器验收（Playwright chromium 对 3010 dev 服务）见上，全部 PASS。

## 遗留事项

- `ww-ce250bc4`（Windows runner）仍未重连：Dashboard Remote Runners 区已能正确显示其
  offline / 从未连接；待 Windows 侧用新脚本重启 runner 后即可看到 online、host/lastSeen/
  harnesses/workspace 实时更新（S02 已在本机 `s02-selftest` 验证同一路径）。
- S01 遗留的“真机长超时实测”仍待 Windows runner 重启后一并验收。
- 本轮 `npm run build` 覆盖了 dev 服务共享的 `.next` 缓存导致其短暂 500（webpack chunk
  缺失），已重启 `agent-platform-dev.service` 恢复（active、/login 与 /api/health 200）；
  feishu/scheduled-jobs/remote-runner-gateway 服务全程未受影响。后续在本机执行
  `npm run build` 前建议先停 dev 服务或改用独立 dist 目录。
- 空 capabilities 为上游真实状态；若未来 harness 上报能力，卡片将自动展示，无需再改契约。

## 2026-08-19 增补交付

1. **Runner 工作目录配置**（`7f24286`）：Dashboard 的 Remote Runners 卡片可保存工作目录，
   在线 runner 通过现有 WebSocket 协议立即接收新目录；离线 runner 在下次连接时取得已保存目录。
2. **离线 Runner 删除**（`2003a99`）：离线卡片新增原生确认删除；服务端按当前用户所有权和
   `offline` 状态原子删除。在线 runner 即使在点击期间发生状态竞争也不会被删除。真机已由用户
   验收删除成功；删除后的 runner 必须重新配对才能再次连接。
3. **发现与加入房间说明**：Remote Runner 存在于 `RemoteNode`，不是 `/ap agents` 枚举的
   `Agent`，也不是 `/ap hosts` 枚举的 `RemoteHarnessHost`，所以
   `desktop-5cn8jha-a825c20c` 不会出现在这两个命令中。可在 Dashboard 的
   **Remote Runners** 区确认节点名、在线状态、`harnesses` 和工作目录；该节点上报
   `pi-agent` 后，其房间选择器为：

   ```text
   remote-node:desktop-5cn8jha-a825c20c:pi-agent
   ```

   向当前已绑定的飞书 Live Room 添加成员：

   ```text
   /ap add --agents=remote-node:desktop-5cn8jha-a825c20c:pi-agent
   ```

   创建新房间时直接指定：

   ```text
   /ap room --agents=remote-node:desktop-5cn8jha-a825c20c:pi-agent
   ```

   选择器只有在节点仍已注册且 metadata 中已上报 `pi-agent` 时才能解析；删除节点后需先重新
   配对并连接。Web/API 目录对普通用户只返回自己拥有的 RemoteNode，管理员可见全部节点。

## 增补验证

- `npm run test:dashboard-visibility`、`npx tsc --noEmit`、目标 ESLint、
  `npm run check:long-files`、`git diff --check` 通过。
- 新增 `DELETE /api/remote-nodes` 鉴权规则已直接验证；独立 auth inventory 仍被既有的
  `GET runner.js/route.ts` 映射缺失阻塞，与本次增补无关。
