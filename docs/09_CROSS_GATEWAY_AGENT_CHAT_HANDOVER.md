# 09 Cross Gateway Agent Chat Handover

## 当前阶段
- 平台已经完成最小跨 Gateway Agent 对话闭环。
- Dashboard 已经可以直接在 Linux / Windows 两台 Gateway 之间发起可见 transcript。
- Gateway Agent 下拉不再只依赖手工输入，已经支持：
  - 平台内保存 `runtimeAgentId`
  - Dashboard 下拉选择
  - 平台内一键刷新远端 OpenClaw agents

## 已完成能力
1. 最小跨 Gateway Agent Chat API
- 路径：`POST /api/gateways/chat`
- 已支持输入：
  - `fromGatewayId`
  - `toGatewayId`
  - `fromAgentId`
  - `toAgentId`
  - `prompt`
  - `turns`
- 当前可跑：
  - 1 轮
  - 2 轮：`User -> A -> B -> A`

2. Transcript 返回与历史记录
- 路径：
  - `POST /api/gateways/chat`
  - `GET /api/gateways/chat`
- 已落库：
  - `CrossGatewayChatSession`
  - `CrossGatewayChatMessage`
- 注意：
  - 仓库历史 migration 链有旧问题，`migrate dev` 不是当前可信路径
  - 本地联调使用过 `prisma db push` + `prisma generate`

3. Dashboard 跨 Gateway 对话面板
- 文件：`src/components/dashboard/CrossGatewayChatPanel.tsx`
- 当前已支持：
  - 选择 Gateway A / Gateway B
  - 选择两边 agentId
  - 1 轮 / 2 轮切换
  - 显示 transcript
  - 显示最近会话历史

4. Gateway Agent 元数据绑定
- `Agent.runtimeAgentId` 已加入 Prisma schema
- Gateway 注册/心跳时已支持保存真实可调用 agentId
- 平台对 agent 调用值优先使用：
  - `runtimeAgentId`
  - 其次才回退到旧的 `id/name`

5. 平台内一键刷新远端 OpenClaw agents
- 新增服务端 WS 控制面 client：
  - `src/lib/openclaw-gateway-rpc.ts`
- 新增刷新 API：
  - `POST /api/gateways/[id]/agents/refresh`
- Dashboard 已加 `刷新 Agents` 按钮
- 刷新后会把远端 `agents.list` 同步进平台数据库，再更新下拉框

## 已验证事实
- Linux Gateway 已可从平台侧通过 WS 控制面成功执行：
  - `connect.challenge`
  - `connect`
  - `agents.list`
- Windows Gateway 也已可从平台侧成功刷新 agents
- 当前平台中两台 Gateway 的 agent 列表已真实可见

Linux 当前已验证的 agents：
- `main`
- `claude`
- `codex`
- `gemini-cli`
- `gemini-test`
- `local-qwen`
- `status`

Windows 当前已验证的 agents：
- `main`
- `claude`
- `coder`
- `codex`
- `gemini`
- `ops`
- `qa`
- `researcher`

## 关键前提配置
要让平台侧“刷新远端 agents”真正工作，远端 OpenClaw 需要至少满足：

1. `gateway.controlUi.allowedOrigins` 包含平台地址
- 例如：
  - `http://10.0.8.4:3010`

2. 远端当前联调阶段启用了：
- `gateway.controlUi.dangerouslyDisableDeviceAuth: true`

说明：
- 只加 `allowedOrigins` 不够
- 对当前这种非 localhost、非 HTTPS 的平台访问方式，真正让控制面通过的是：
  - `dangerouslyDisableDeviceAuth: true`

## ACP / OpenClaw 当前结论
- 当前平台支持的是“被 OpenClaw `/v1/responses` 和控制面暴露出来的 agent”
- 如果 ACP agent 最终映射成 OpenClaw 可调用 agentId，那么当前方案可用
- 如果 agent 只存在于 ACP 控制面、没有暴露到 OpenClaw HTTP/WS 能力里，当前方案不可直接调用

## 本阶段核心代码变更
- `src/app/api/gateways/chat/route.ts`
- `src/components/dashboard/CrossGatewayChatPanel.tsx`
- `src/components/dashboard/index.ts`
- `src/app/page.tsx`
- `src/lib/openclaw-client.ts`
- `src/lib/openclaw-gateway-rpc.ts`
- `src/app/api/gateways/[id]/agents/refresh/route.ts`
- `src/app/api/gateways/register/route.ts`
- `src/app/api/gateways/route.ts`
- `src/types/index.ts`
- `src/types/ws.d.ts`
- `prisma/schema.prisma`
- `prisma/migrations/20260321180556_add_cross_gateway_chat_history/`
- `prisma/migrations/20260321193000_add_agent_runtime_agent_id/`
- `scripts/register-remote-gateway.js`

## 下一步最值得做的事
1. 选择 Gateway 后自动静默刷新一次 agents
- 现在已经有按钮
- 下一步可以减少手动点击

2. 支持“继续当前会话”
- 让用户在已有 transcript 上继续多轮对话
- 而不是每次都新开 session

3. 让 transcript 显示更完整身份信息
- 每条消息都明确显示：
  - gateway 名称
  - agentId
  - speaker

4. 再往上接 meeting / orchestrator
- 现在底层调用闭环和 agent 发现机制都已有了
- 可以在此之上再做更高层的会议编排

## 新会话推荐起手阅读
1. `docs/04_HANDOVER.md`
2. `docs/07_OPENCLAW_HTTP_MILESTONE.md`
3. `docs/08_OPENCLAW_HTTP_HANDOVER.md`
4. `docs/09_CROSS_GATEWAY_AGENT_CHAT_HANDOVER.md`
