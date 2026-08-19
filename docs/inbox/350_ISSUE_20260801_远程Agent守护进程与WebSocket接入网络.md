---
doc_type: ISSUE
doc_status: draft
next_action: none
---

# ISSUE · 远程 Agent WebSocket 守护进程与跨机器 Agent 协作网络

## 状态

- 优先级：P1，扩展跨机器分布式 Agent 架构的核心基础设施。
- 当前处理：仅记录到 Git Inbox，待后续 Workflow 排期评估。
- 提出时间：2026-08-01。

## 问题与背景

1. 平台总服务（Master Platform Service）运行在中央节点，远端机器（其他服务器或开发机）上的 Agent 无法直接接入中央平台。
2. 缺乏标准化、轻量级的客户端服务建立稳定持久通信通道，限制了分布式部署与跨机器 Agent 的协同能力。

## 需求与设计规范

### 1. 远程 Agent 轻量级守护进程 (Remote Agent Daemon)
- 在远端机器运行轻量级的 `agent-daemon` 小服务。
- 启动后向中央主服务发起基于 WebSocket (WSS) 的双向长连接。
- 内置心跳保持、自动重连、节点鉴权（Token/Secret 认证）与节点状态上报能力。

### 2. 节点与 Agent 注册管理
- 中央服务支持注册与管理远程节点及其上挂载的 Agent (选择器格式如 `remote-node:codex` 或 `agent@remote-host`)。
- 节点掉线时在平台实时标记节点与成员为 `offline`，连接恢复后自动同步恢复。

### 3. 跨机器 Agent 对话与指导网络
- 允许中央强力 Agent（如中央节点上的 Codex/Claude/Antigravity）与远程机器上的 Agent 进行实时消息传递、任务协同与技术指导。
- 提供标准化的 Agent-to-Agent 消息协议与远端指令控制通道。

### 4. 已完成：Remote Runner Workspace 易配置（2026-08-19）
- Dashboard 的 Remote Runners 区域可为在线节点修改 workspace；离线节点禁止提交。
- 更新沿用现有 Gateway HTTP 桥接与 runner WebSocket，通过 runner 所在机器校验目录存在且为目录，
  成功后写回 `%USERPROFILE%\.agent-platform\runner.json`，不需要重新配对，也没有第二套配置模型。
- runner 更新后立即重发 `hello`，中央节点 metadata 与 Dashboard 展示同步刷新；新目录明确标注为
  Pi 的文件和工具访问边界。
- Gateway 的 workspace 控制入口仅接受本机 loopback 请求，节点访问继续遵循现有用户所有权校验。

## 验收标准

1. 远端机器启动 `agent-daemon` 后，能自动在中央主服务注册并保持 WebSocket 长连接。
2. 中央主服务和房间内的成员可以向远端 Agent 发送指令并实时接收回复与过程日志。
3. 节点掉线与网络波动时具备优雅的断线重连与状态容错能力。
4. 用户无需重新配对即可持久更改 runner workspace；重启后 Pi 在新边界内执行，
   Dashboard 显示值与 runner 实际配置一致。
