# 36 ACPX Unify Live Room Execution With Local And Remote Agents Handover

## 日期
2026-03-25

## 本文目的

回答两个问题：

1. `Live Room` 现在到底是怎么启动本地 `Platform Local Codex / Claude` 和 `remote_ssh` agent 的
2. 是否值得把 `Live Room` 的本地 agent 也一起迁移到 ACPX，而不是只处理 `remote_ssh`

## 当前事实

### 1. Live Room 当前没有走完整 ACPX 编排

`Live Room` 当前主执行入口是：
- [live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts)

它会直接按 backend 分流：
- `platform_local`
  - 直接调用 [executeCodexTask](/data1/code/agent-platform-v2/src/lib/real-agents/codex-agent.ts)
  - 或 [resumeCodexSession](/data1/code/agent-platform-v2/src/lib/real-agents/codex-agent.ts)
  - 或 [executeClaudeTask](/data1/code/agent-platform-v2/src/lib/real-agents/claude-agent.ts)
- `remote_ssh`
  - 直接调用 [executeRemoteSshTask](/data1/code/agent-platform-v2/src/lib/remote-harness/ssh-executor.ts)
- `gateway_openclaw`
  - 直接走 gateway RPC / OpenClaw HTTP 路径

也就是说：
- **Live Room 当前是“轻量直调”模型**
- 并不是 ACPX 的 `taskRun / participant / event bus / process registry` 模型

### 2. ACPX 本身已经同时支持 local 和 remote_ssh

ACPX 的运行入口是：
- [acpx/runner.ts](/data1/code/agent-platform-v2/src/lib/acpx/runner.ts)

里面已经有：
- `platform_local` 路径
- `remote_ssh` 路径
- `gateway_openclaw` 路径

尤其：
- `executeViaLocalHarness(...)`
- `executeViaRemoteSshHarness(...)`

都已经是 ACPX 统一体系的一部分。

所以技术上不是“要不要先发明一套新 remote runner”，
而是：
- **是否让 Live Room 也复用 ACPX 已有执行框架**

## 当前两套模型的差别

### A. Live Room 直调模型的优点

优点：
- 实现简单
- 延迟链路短
- 适合快速把“房间消息 -> agent 回复”跑通
- 不必引入完整 `taskRun` 生命周期

适合：
- 本地单 agent 快速对话
- 初期验证 mention / speaker / room UX

### B. Live Room 直调模型的缺点

当前暴露出来的问题基本都和它有关：

1. 缺少强约束的并发治理
   - 同一 remote member 会积累多个 pending delivery
   - 可能同时起多个 Claude 进程

2. 缺少统一 process registry / ownership
   - remote 进程已经起了，但 room 侧很难精确知道“这个 PID 属于哪条 delivery”

3. 缺少成熟的 activity / streaming / control 语义
   - 只能后补一些 `pending` / `heartbeat` / `progress` 文本
   - 不如 ACPX 原生的 `activityState`

4. interrupt / supersede / queue 语义弱
   - 特别是 remote_ssh

5. 观测能力分散
   - room 自己维护一套
   - ACPX 自己又有一套

### C. ACPX 模型的优点

ACPX 已经具备：

1. `taskRun / participant` 记录
2. `publishTaskRunEvent(...)` 事件流
3. `process-registry`
4. `activityState`
5. `control message`
6. `interrupt / stop / continue_session`
7. local Codex thread tracking
8. capability / permission support

这意味着：
- 如果 Live Room 复用 ACPX
- local 和 remote 可以进入同一套生命周期管理

## 结论：是否也该让 local agent 走 ACPX

### 结论一：长期看，值得

是的，**长期看本地 agent 也值得纳入 ACPX 统一执行层**。

原因不是“本地现在已经坏了”，
而是：
- 统一 local / remote / gateway 的调度模型
- 统一 pending / running / stalled / interrupted 语义
- 统一控制与观测

这会让 Live Room 的底层从“直调脚本”升级为“受控执行系统”。

### 结论二：短期最高 ROI 是 remote_ssh 优先

虽然本地也能从 ACPX 获益，
但**最急的痛点不是本地，而是 `remote_ssh`**。

原因：
- 当前真正失控的是 remote Claude backlog / stale pending / 多进程堆积
- 本地 Codex / Claude 虽然不完美，但没有表现出同等级别的不稳定性

所以优先级建议是：

1. 先把 Live Room 的 `remote_ssh` 回复纳入 ACPX 风格控制
2. 再评估是否把 `platform_local` 也一并迁移

## 如果只迁 remote_ssh，会怎样

这是一个现实可行的中间态：

- `platform_local` 暂时保留当前直调
- `remote_ssh` 改成 ACPX participant / runner 方式

优点：
- 改动范围较小
- 先解决最痛点

缺点：
- 体系仍然分裂
- Live Room 里 local / remote 两套执行语义不同
- 后续 status / interrupt / queue 还是会有不一致

所以它是可行的**阶段性方案**，
但不是最漂亮的长期方案。

## 如果 local 也一起迁，会得到什么

如果 `platform_local` 也进入 ACPX：

### 会得到的收益

1. Local / Remote 一致的 participant 语义
2. 更统一的 streaming 事件
3. 更统一的 pending / running / stalled 判定
4. 更统一的 interrupt / continue_session 入口
5. 更统一的 process registry
6. 后续 room UI 可以直接消费 ACPX 事件，而不是 room 自己补轮询逻辑

### 需要付出的成本

1. Live Room 需要引入 ACPX run/session 映射
2. 需要决定：
   - 一条 room message 对应一个 run？
   - 还是一个 room member 拥有持续 participant session？
3. UI 需要从“房间消息视图”适配一部分 ACPX 运行状态
4. Claude 本地目前不像 Codex 那样有成熟 resume thread 语义

也就是说：
- local 迁移**是值得的**
- 但它更偏“架构统一工程”
- 不是现在最紧急的生产问题修复

## 推荐路线

### 路线建议

#### Phase 1. 先把 remote_ssh 纳入 ACPX 风格约束

目标：
- 同一 remote member 同时只允许 1 个 active job
- 后续消息排队 / supersede
- 具备明确 process ownership
- 能 interrupt / fail stale jobs

#### Phase 2. 抽象出 Live Room -> ACPX bridge

目标：
- room message 触发 participant execution
- 但底层由 ACPX 负责 run / event / status

#### Phase 3. 再把 platform_local 迁入同一桥接层

目标：
- local codex / claude 和 remote_ssh 使用同一调度语义
- Live Room 只关心房间逻辑，不再自己维护多套执行状态

## 当前建议给下一位 agent

### 如果目标是“尽快止血”

优先做：
- remote_ssh 单 member 单 active job
- stale pending cleanup
- PID / delivery ownership

### 如果目标是“中期可维护”

继续做：
- Live Room 与 ACPX 的桥接设计

### 如果目标是“长期统一架构”

最终应该：
- local / remote / gateway 全都走统一 ACPX 执行层

## 涉及关键文件

- [live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts)
- [codex-agent.ts](/data1/code/agent-platform-v2/src/lib/real-agents/codex-agent.ts)
- [claude-agent.ts](/data1/code/agent-platform-v2/src/lib/real-agents/claude-agent.ts)
- [ssh-executor.ts](/data1/code/agent-platform-v2/src/lib/remote-harness/ssh-executor.ts)
- [acpx/runner.ts](/data1/code/agent-platform-v2/src/lib/acpx/runner.ts)
- [acpx/types.ts](/data1/code/agent-platform-v2/src/lib/acpx/types.ts)
- [acpx/process-registry.ts](/data1/code/agent-platform-v2/src/lib/acpx/process-registry.ts)
