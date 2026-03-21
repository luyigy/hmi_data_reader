# 07 OpenClaw HTTP Milestone

## 日期
- 2026-03-21

## 本次里程碑结论
- 平台侧多 Gateway 注册/心跳已跑通。
- Linux 与 Windows 两台 OpenClaw 都已可通过平台登记为在线 Gateway。
- 平台健康检查已修正为优先探测 OpenClaw 的 `/health`，不再只依赖旧的 `/api/health`。
- 两台 OpenClaw 的 HTTP AI 端点已验证开启成功：
  - `POST /v1/responses`
  - `POST /v1/chat/completions`
- 两台 OpenClaw 都要求使用各自的 OpenClaw gateway token 访问这些 AI HTTP 端点。
- Linux 与 Windows 均已手工验证 `POST /v1/responses` 成功返回真实 agent 回复。

## 已验证环境
- Agent Platform:
  - 主控机: `10.0.8.4`
  - 开发端口: `3010`
- OpenClaw Linux:
  - 地址: `10.0.8.4:18789`
  - `GET /health`: 200
  - `POST /v1/responses`: 401 未授权，带正确 OpenClaw token 后成功
- OpenClaw Windows:
  - 地址: `10.0.8.3:18789`
  - `GET /health`: 200
  - `POST /v1/responses`: 401 未授权，带正确 OpenClaw token 后成功

## 关键发现
- 平台 token 与 OpenClaw token 不是一回事。
- 平台 token 只用于：
  - `POST /api/gateways/register`
  - 平台内部的 Gateway 身份识别
- OpenClaw token 只用于：
  - `POST /v1/responses`
  - `POST /v1/chat/completions`
  - 其他 OpenClaw 自身 HTTP/WS 入口
- 因此平台后续若要调用真实 OpenClaw agent，必须为每个 Gateway 单独保存 OpenClaw 凭证，不能复用平台 token。

## 代码侧当前状态
- 已修复平台 Gateway 注册逻辑：
  - token 与 `gatewayId` 强绑定
  - `url` 规范化为 `http://host:port`
- 已修复 Gateway 测试接口：
  - 优先使用 `/health`
  - 兼容 `/healthz`
  - 最后回退 `/api/health`
- 当前 `src/lib/gateway-router.ts` 依然是假设“目标网关暴露平台私有的 `/api/gateways/messages/incoming`”。
- 这套消息投递路径不适用于原生 OpenClaw。
- 下一阶段不应继续强化这条旧路径，而应新增 OpenClaw adapter。

## 当前阻塞已解除
- 网络不通：已解除
- Windows 端口混乱：已定位并修复到 `18789`
- OpenClaw HTTP endpoint 缺失：已通过配置启用
- OpenClaw token 可用性不明：已验证可用

## 下一阶段目标
- 在平台中增加 Gateway 级别的 OpenClaw token 配置能力。
- 新增 OpenClaw HTTP adapter，优先接 `POST /v1/responses`。
- 先实现“平台 -> 指定 gateway -> 指定 OpenClaw agent -> 获取回复”的最小闭环。
- 之后再做多 Agent 会议编排与跨 Gateway 对话。
