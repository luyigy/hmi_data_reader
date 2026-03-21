# 08 OpenClaw HTTP Handover

## 当前项目处于什么阶段
- 平台 UI、Gateway 注册、心跳、基础健康检查已经可用。
- OpenClaw 双机联调已完成到“HTTP AI endpoint 可真实调用”的阶段。
- 还没有完成平台内的 OpenClaw adapter，也还没有完成真正的跨 Gateway Agent 对话闭环。

## 本次联调后的可信事实
- Linux OpenClaw:
  - `http://10.0.8.4:18789/health`
  - `http://10.0.8.4:18789/v1/responses`
- Windows OpenClaw:
  - `http://10.0.8.3:18789/health`
  - `http://10.0.8.3:18789/v1/responses`
- 两台 OpenClaw 当前都能在带正确 OpenClaw token 的情况下响应真实请求。

## 千万不要再混淆的两套 token
- 平台 token:
  - 来源: `POST /api/gateways/token`
  - 用途: Gateway 注册、心跳、平台身份认证
- OpenClaw token:
  - 来源: OpenClaw 自身配置/安装脚本
  - 用途: 访问 OpenClaw 的 `/v1/responses`、`/v1/chat/completions`、WS 控制面等

一句话：
- 平台 token 不能直接拿去调用 OpenClaw AI endpoint。

## 建议的下一步实现顺序
1. 新增 Gateway 的 OpenClaw 凭证存储
- 最少需要保存：
  - `gatewayId`
  - `openclawBaseUrl`
  - `openclawToken`
- 凭证建议继续使用现有加密工具加密存储。

2. 新增 OpenClaw HTTP client
- 建议封装一个独立模块，例如：
  - `src/lib/openclaw-client.ts`
- 第一版只做：
  - `healthCheck(baseUrl, token)`
  - `createResponse(baseUrl, token, { model, input, sessionKey? })`

3. 新增平台内部调用入口
- 建议先增加一个受限 API，例如：
  - `POST /api/gateways/[id]/openclaw/respond`
- 输入：
  - `agentId` 或默认 `main`
  - `input`
- 输出：
  - 原始 OpenClaw response 或平台规范化后的 message

4. 再把它接入现有任务/聊天/meeting 逻辑
- 在真正打通 adapter 之前，不要急着改会议编排层。
- 先让“单个远程 agent 被平台成功调用并返回结果”稳定下来。

## 为什么优先用 `/v1/responses`
- 已实际验证可用。
- 语义更适合后续多轮、工具调用和更复杂的 agent 输出。
- 比直接接旧的私有消息接口更贴近 OpenClaw 当前官方支持路径。

## 不建议继续做的旧方向
- 不要继续假设 OpenClaw 原生支持平台自定义的：
  - `/api/gateways/messages/incoming`
- 不要把平台 token 当成 OpenClaw token 使用。
- 不要先做 A2A 再回头补最小调用闭环。

## 本次相关代码变更
- `src/app/api/gateways/register/route.ts`
- `src/app/api/gateways/token/route.ts`
- `src/app/api/gateways/[id]/test/route.ts`
- `src/lib/gateway-router.ts`
- `scripts/register-remote-gateway.js`
- `src/app/api/health/route.ts`

## 建议新会话阅读顺序
1. `docs/04_HANDOVER.md`
2. `docs/05_MULTI_GATEWAY_AGENT_MEETING_PLAN.md`
3. `docs/06_STAGE1_MULTI_GATEWAY_MVP_CHECKLIST.md`
4. `docs/07_OPENCLAW_HTTP_MILESTONE.md`
5. `docs/08_OPENCLAW_HTTP_HANDOVER.md`
