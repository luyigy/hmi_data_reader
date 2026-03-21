# 06 Stage 1 Multi-Gateway MVP Checklist

## 目的
本文件将 `docs/05_MULTI_GATEWAY_AGENT_MEETING_PLAN.md` 中的“阶段 1：打通多 Gateway 真实通信 MVP”进一步拆解为可执行任务清单。

适用目标:
- Control plane 运行在 `10.0.8.4`
- 远端 OpenClaw / Gateway 测试机为 `10.0.8.3`
- 第一阶段先不做真实 Agent 会议
- 第一阶段只完成多 Gateway 的真实注册、鉴权、心跳、双向消息闭环

## 阶段 1 定义

### 本阶段要解决的问题
- Gateway 注册是否真实可用
- Gateway token 身份是否正确绑定
- Gateway 间消息是否能双向发送
- 接收端是否能正确校验发送者身份
- 消息是否有基础状态、错误和回执
- 两台测试机是否能稳定完成联调

### 本阶段暂不包含
- ACPX agent 真实调用
- Codex/Claude 真实互相对话
- Meeting 编排
- A2A 标准化适配

## 成功标准
- `10.0.8.4` 和 `10.0.8.3` 都能在平台中显示为在线 Gateway
- 两边注册和心跳正常
- 两边都能通过平台完成双向消息发送
- 平台能区分发送成功、接收成功、处理失败
- 基础错误可被定位，不再只有“发不通”这种模糊状态

## 工作分解

## A. 统一网络与测试约定
### A1. 固定角色
- [ ] 确认 `10.0.8.4` 为 control plane
- [ ] 确认 `10.0.8.3` 为 remote gateway
- [ ] 后续第一阶段统一使用 WireGuard 地址

### A2. 固定 URL 规则
- [ ] 定义 control plane 基础地址，例如 `http://10.0.8.4:3000`
- [ ] 定义远端 gateway 基础地址，例如 `http://10.0.8.3:<gateway-port>`
- [ ] 所有注册、健康检查、消息投递统一走 `10.0.8.x`

### A3. 基础连通性验证
- [ ] `10.0.8.4` 能访问 `10.0.8.3`
- [ ] `10.0.8.3` 能访问 `10.0.8.4`
- [ ] 两边可访问健康检查端点
- [ ] 记录联调时使用的端口

## B. 明确 Gateway 身份模型
### B1. 定义身份原则
- [ ] 一个 Gateway 对应一个唯一 `gatewayId`
- [ ] 一个 Gateway 对应一份独立 token
- [ ] token 校验结果必须与 `gatewayId` 一致

### B2. 明确注册规则
- [ ] 注册时，token 所属 Gateway 与请求体 `gatewayId` 必须一致
- [ ] 不允许 A Gateway 的 token 更新 B Gateway 的记录
- [ ] 对首次接入和已存在 Gateway 的处理规则要明确

### B3. 明确消息发送规则
- [ ] 发送消息时要明确“谁是发送者 Gateway”
- [ ] 接收端校验 `fromGatewayId` 与 token 解析出的 Gateway 是否一致
- [ ] 禁止冒充其他 Gateway 发送消息

## C. 修正注册与心跳闭环
### C1. 注册接口改造
- [ ] 审查 `POST /api/gateways/register`
- [ ] 修正 token 与 `gatewayId` 的绑定校验
- [ ] 明确首次注册、重复注册、重启后重连的行为
- [ ] 明确 `url/ip/port` 的存储规则

### C2. 心跳接口行为校验
- [ ] 心跳成功时更新 Gateway 在线状态
- [ ] 心跳成功时同步远端 agent 在线状态
- [ ] 远端 agent 不存在时如何处理要明确
- [ ] 心跳失败时的状态降级策略要明确

### C3. 注销与离线处理
- [ ] 主动注销时 Gateway 标记为 `offline`
- [ ] 关联 agent 标记为 `offline`
- [ ] 异常断线时通过超时或健康检查补标离线

## D. 修正消息投递闭环
### D1. 发送端逻辑梳理
- [ ] 审查 `src/lib/gateway-router.ts`
- [ ] 明确发送时使用的是哪一侧 token
- [ ] 明确发送目标 URL 拼接规则
- [ ] 明确发送失败时状态应该是 `failed` 还是 `pending`

### D2. 接收端逻辑梳理
- [ ] 审查 `POST /api/gateways/messages/incoming`
- [ ] 接收端必须验证 sender 身份
- [ ] 接收端必须写入标准化消息记录
- [ ] 接收端返回结构化回执

### D3. 基础回执设计
建议至少区分以下状态：
- `queued`
- `sent`
- `received`
- `processed`
- `failed`

建议至少记录以下字段：
- `messageId`
- `fromGatewayId`
- `toGatewayId`
- `correlationId`
- `status`
- `error`
- `createdAt`
- `receivedAt`
- `processedAt`

### D4. 重试策略
- [ ] 明确哪些失败可以自动重试
- [ ] 明确哪些失败应直接标记 `failed`
- [ ] 明确重试次数和间隔
- [ ] 明确如何避免重复投递

## E. 建立最小可观测性
### E1. 日志
- [ ] 注册日志包含 `gatewayId`、来源地址、结果
- [ ] 心跳日志包含 `gatewayId`、时间、结果
- [ ] 消息日志包含 `messageId`、发送方、接收方、状态
- [ ] 错误日志能区分鉴权失败、网络失败、接收端失败

### E2. 查询能力
- [ ] 能查看当前所有 Gateway 状态
- [ ] 能查看消息历史
- [ ] 能查看 pending / failed 消息
- [ ] 能查看最后一次心跳时间

### E3. 手工联调脚本
- [ ] 准备一组 curl 或脚本命令用于注册
- [ ] 准备一组命令用于心跳
- [ ] 准备一组命令用于双向发消息
- [ ] 准备一组命令用于检查消息状态

## F. 数据模型检查
### F1. 现有表复用评估
- [ ] `Gateway`
- [ ] `Agent`
- [ ] `GatewayMessage`
- [ ] `IncomingGatewayMessage`
- [ ] `ControlPlaneState`

### F2. 判断是否需要小改字段
优先做最小改动，但需要评估是否补充以下字段：
- [ ] `verified`
- [ ] `lastHeartbeat`
- [ ] `correlationId`
- [ ] `ackStatus`
- [ ] `retryCount`
- [ ] `lastError`

### F3. 约束检查
- [ ] `gatewayId` 是否足够稳定
- [ ] 远端 agent 的 ID 规则是否稳定
- [ ] 是否需要为消息增加唯一幂等键

## G. 测试计划

### G1. 注册测试
- [ ] 合法 token + 正确 `gatewayId` 可以注册成功
- [ ] 合法 token + 错误 `gatewayId` 被拒绝
- [ ] 缺失 token 被拒绝
- [ ] 无效 token 被拒绝

### G2. 心跳测试
- [ ] 在线 Gateway 心跳成功
- [ ] 已注册 agent 状态被刷新
- [ ] 心跳异常时状态正确变化

### G3. 消息发送测试
- [ ] `10.0.8.4 -> 10.0.8.3` 成功
- [ ] `10.0.8.3 -> 10.0.8.4` 成功
- [ ] token 不匹配时拒绝
- [ ] 目标 Gateway 不存在时返回明确错误
- [ ] 目标 URL 不可达时返回明确错误

### G4. 断线恢复测试
- [ ] 远端 gateway 停止后平台状态变化正确
- [ ] 恢复后可重新注册或心跳恢复
- [ ] pending 消息行为符合预期

## H. 交付物
本阶段完成后，至少应有以下交付物：
- [ ] 修正后的 Gateway 注册逻辑
- [ ] 修正后的 Gateway 鉴权逻辑
- [ ] 修正后的 Gateway 消息发送/接收逻辑
- [ ] 一组可复用的联调命令或脚本
- [ ] 一份阶段 1 测试结果记录

## 建议开发顺序
1. 先固定网络与测试角色
2. 再修 token 与 `gatewayId` 身份绑定
3. 再修注册和心跳
4. 再修消息发送和接收
5. 再补状态、错误和重试
6. 最后做双机联调验证

## 下一次正式开工建议
如果下一次会话准备开始改代码，建议按这个顺序启动：
1. 先读 `docs/04_HANDOVER.md`
2. 再读 `docs/05_MULTI_GATEWAY_AGENT_MEETING_PLAN.md`
3. 再读本文件
4. 先从 Gateway 身份模型和注册接口开始改
5. 改完立刻做双机注册与消息联调

---

作者: Codex
日期: 2026-03-21
