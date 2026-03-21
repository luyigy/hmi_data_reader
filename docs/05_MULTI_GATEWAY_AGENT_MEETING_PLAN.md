# 05 Multi-Gateway Agent Meeting Plan

## 背景
- 当前项目已完成管理端 UI、Gateway/Agent 基础模型、注册接口、消息表结构和部分控制面代码。
- 当前项目尚未完成跨 Gateway 的真实消息闭环，也未完成 Agent 真实对话、任务协作、会议编排。
- 目标是让多个 OpenClaw Gateway 连接到 Agent Platform 后，不同 Gateway 上的 Agent 可以互相通信、协作，并逐步实现“开会式”多 Agent 协同。

## 当前测试环境

### 网络与机器
- 主服务器 / Agent Platform 候选主控机:
  - 局域网 IP: `192.168.1.4`
  - WireGuard IP: `10.0.8.4`
- Windows Server / 远端 OpenClaw:
  - 局域网 IP: `192.168.1.3`
  - WireGuard IP: `10.0.8.3`

### 已知条件
- 两台机器都运行 OpenClaw 实例
- 两台机器都安装了 `acpx` plugin
- 后续希望同机和跨机的 Codex、Claude Code 等 harness/agent 都可以互相通信

## 总体目标

### 目标 1：多 Gateway 连通
- Agent Platform 能稳定连接多个 Gateway
- Gateway 能完成注册、心跳、鉴权、连通性检测
- Gateway 之间可以双向投递结构化消息

### 目标 2：真实 Agent 通信
- 平台不仅记录 Agent 元数据，还能真实调用 Gateway 上的 Agent
- 同机 Agent 可互相通信
- 跨机 Agent 可互相通信

### 目标 3：多 Agent 会议
- 多个 Agent 在同一 meeting 中轮流发言
- 平台负责上下文、轮次、参与者和总结
- 后续逐步兼容 A2A 协议

## 架构方向

### 分层原则
建议分三层推进，不要一次性把注册、通信、Agent 执行、会议和 A2A 全部混在一起做。

1. Gateway 通信层
- 负责 Gateway 注册、鉴权、心跳、健康检查、消息投递、回执、重试

2. Agent Adapter 层
- 负责把“平台消息”转换为“OpenClaw/ACPX/本地 harness 可执行的请求”
- 对不同类型 Agent 提供统一接口

3. Meeting / Orchestrator 层
- 负责会议创建、发言轮次、上下文管理、总结与协同策略

### A2A 的定位
- A2A 适合作为中后期的跨 Agent 互通协议层
- A2A 不是会议编排本身
- 短期先完成平台内部事件模型和真实通信闭环
- 中期在 Gateway/Agent Adapter 外增加 A2A adapter

## 统一网络策略
- 第一阶段统一优先使用 WireGuard 地址
- 所有 Gateway URL、健康检查地址、消息地址统一使用:
  - 主控机: `10.0.8.4`
  - 远端机: `10.0.8.3`
- 避免在数据库和配置中混用 `192.168.1.x` 与 `10.0.8.x`

## 实施阶段

## 阶段 0：确定控制面与网络基线
### 目标
- 明确哪台机器作为 control plane
- 明确两台机器的统一访问地址
- 验证网络基础能力

### 当前建议
- 使用 `10.0.8.4` 作为 control plane 所在机器
- 使用 `10.0.8.3` 作为远端 Gateway 测试机

### 输出
- 固定 control plane 角色
- 固定两台 Gateway 的 URL 规范
- 能通过 WireGuard 地址互 ping、互 curl、互访健康检查端点

## 阶段 1：打通多 Gateway 真实通信 MVP
### 目标
- 两个 Gateway 能真实注册、鉴权、心跳、双向消息投递

### 需要完成
- 修正 Gateway token 与 `gatewayId` 的身份绑定
- 修正注册接口鉴权逻辑
- 修正消息发送与接收端的身份匹配逻辑
- 修正 Gateway URL 和 token 使用方式
- 增加消息状态与基础回执

### MVP 验收标准
- 平台中可看到两个 Gateway 都为 `online`
- 两边 Agent 列表可以同步显示
- `10.0.8.4 -> 10.0.8.3` 可发送测试消息并收到回执
- `10.0.8.3 -> 10.0.8.4` 可发送测试消息并收到回执
- 某一边断开后平台能识别为 `offline` 或 `unhealthy`

## 阶段 2：实现 Agent Adapter 层
### 目标
- 平台不再只“记录 Agent”，而是能真实调用 Agent

### 建议抽象接口
- `listAgents()`
- `sendToAgent(agentId, message, context)`
- `startTask(agentId, task, context)`
- `streamEvents(...)`
- `cancelTask(...)`

### 计划中的 Adapter
- `LocalAgentAdapter`
- `OpenClawAcpxAdapter`

### 关键问题
- `acpx` plugin 是否提供稳定的程序化调用接口
- 是否能列出可用 harness / agent
- 是否支持多轮会话上下文
- 是否支持流式输出
- 是否支持任务取消和并发

### 验收标准
- 本机 Codex / Claude 可被识别为真实 agent
- 远端 Windows 机器上的 agent 可被识别为真实 agent
- 平台可向指定 agent 发送消息并获得真实返回
- 返回结果不再是 mock/template

## 阶段 3：实现同机与跨机 Agent 对话
### 目标
- 让 Agent 真实互相通信，而不是仅显示在 UI 中

### 目标场景
- 同机对话:
  - `10.0.8.4` 上的 Codex 与 Claude 对话
  - `10.0.8.3` 上的 Codex 与 Claude 对话
- 跨机对话:
  - `10.0.8.4` 上的 Codex 与 `10.0.8.3` 上的 Claude 对话
  - `10.0.8.3` 上的 Codex 与 `10.0.8.4` 上的 Claude 对话

### 设计建议
- 第一版不要做完全自由互发
- 先采用“主持人 / 编排器控制发言”的模式
- 所有消息都携带上下文和轮次信息

### 验收标准
- 同机双 Agent 可连续对话至少 3 轮
- 跨机双 Agent 可连续对话至少 3 轮
- transcript 中可看到完整消息链路

## 阶段 4：实现 Meeting / Orchestrator 层
### 目标
- 把“聊天页面”升级为“多 Agent 会议系统”

### 建议新增概念
- `Meeting`
- `MeetingParticipant`
- `MeetingTurn`
- `MeetingEvent`
- `AgentSession`

### 建议支持的会议模式
- `round-robin`
- `moderated`
- `parallel-then-summarize`

### 每轮发言建议携带
- `meetingId`
- `turnId`
- `correlationId`
- `fromGatewayId`
- `toGatewayId`
- `fromAgentId`
- `toAgentId`
- `instruction`
- `contextWindow`
- `expectedOutput`

### 验收标准
- 2 到 4 个 Agent 可在同一 meeting 中轮流发言
- 平台可保存 transcript、turn、summary
- 用户可以看到完整讨论过程和总结

## 阶段 5：引入 A2A Adapter
### 目标
- 支持后续接入更多标准化 Agent
- 降低对单一 OpenClaw/ACPX 方案的耦合

### 原则
- 平台内部继续保留自有 domain model
- 对外逐步兼容 A2A
- 不在第一阶段强依赖 A2A 才能推进

### A2A 更适合承担的职责
- Agent discovery
- capability 描述
- task lifecycle
- 流式状态更新
- 跨框架 / 跨供应商互通

## 第一版推荐里程碑

### 里程碑 1：双 Gateway 可见可测
- 完成注册、心跳、测试连接、健康检查

### 里程碑 2：双 Gateway 可通信
- 完成双向消息投递、接收、回执、失败可诊断

### 里程碑 3：真实 Agent 可调用
- 平台可调用本机和远端的 ACPX agent

### 里程碑 4：双 Agent 对话
- 同机 Codex/Claude 对话
- 跨机 Codex/Claude 对话

### 里程碑 5：多 Agent 会议
- 多个 agent 在一个 meeting 中协同完成一项任务

## 当前优先级建议
1. 先修 Gateway 通信与身份模型
2. 再确认 ACPX/OpenClaw 的程序化接口能力
3. 先做真实 Agent 调用
4. 再做 Agent 对话
5. 最后做 Meeting Orchestrator 与 A2A Adapter

## 下次会话的建议起手步骤
1. 先阅读本文件和 `docs/04_HANDOVER.md`
2. 先确认 control plane 是否固定为 `10.0.8.4`
3. 先检查现有 Gateway 注册、token、message 路由代码
4. 先验证两台机器上的 OpenClaw / ACPX 接口能力
5. 再决定阶段 1 的代码改造范围

## 暂未决事项
- ACPX plugin 的程序化调用接口细节
- OpenClaw 上是否已有标准 health/message/agent invoke API
- 第一版是否需要流式输出
- 第一版是否需要支持一个 agent 同时参加多个 meeting

---

作者: Codex
日期: 2026-03-21
