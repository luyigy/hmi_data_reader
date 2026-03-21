# 12 Feishu Platform Integration Plan

## 目标
- 让用户可以通过 Feishu 在手机上查看和参与 Agent Platform 的对话、状态和协作
- 让平台成为 Feishu 与多 Gateway Agents 之间的中间编排层
- 不再依赖“多个 Gateway bot 在同一个群里自己互相说话”

## 当前现状
- 每个 Gateway 已经有各自的 Feishu bot
- 这些 bot 即使进了同一个群，也不能稳定地互相对话
- 原因不是配置小问题，而是整体交互模型不对

## 核心判断

### 错误方向
- 让多个 Gateway bot 直接在同一 Feishu 群里互相触发、互相回复

### 正确方向
- 让 Agent Platform 做中间层
- Feishu 只作为用户入口和结果展示面
- Gateway Agents 仍然通过平台 orchestrator 协作

## 推荐架构

```text
Feishu 用户 / 群
    |
    v
Agent Platform Feishu Adapter
    |
    v
Conversation / Meeting Orchestrator
    |
    +--> Gateway A / Agent A
    +--> Gateway B / Agent B
    +--> Gateway C / Agent C
    |
    v
结果聚合 / transcript / summary
    |
    v
回发到 Feishu
```

## 推荐产品方案

### 方案 A：平台统一 Feishu Bot
推荐优先做这个。

特点：
- 只有一个“Agent Platform Bot”面向用户
- 用户在 Feishu 群里和平台 bot 交互
- 平台内部再决定调用哪些 Gateway / agent

优点：
- 交互统一
- 不会出现多个 bot 抢着发言
- 权限、群管理、消息格式更简单
- 更适合后续 meeting / summary / history

缺点：
- 不能直接把“每个 Gateway bot”都保留为前台角色

### 方案 B：保留每个 Gateway bot，但平台做幕后编排
只建议作为第二阶段增强。

特点：
- 用户看到多个 bot 还在群里
- 但真正的协调逻辑仍然由平台决定

风险：
- 产品体验容易乱
- bot-to-bot 触发链条难控
- Feishu 平台约束更容易踩坑

## 第一阶段推荐范围

### 1. 先做平台统一入口
- 一个平台 Feishu bot
- 接收群消息 / 私聊消息
- 转成平台内 conversation

### 2. 平台内部做路由
- 判断这是：
  - 单 Gateway 单 agent
  - 跨 Gateway 对话
  - 多 Agent meeting
  - 状态查询

### 3. 平台把结果回发到 Feishu
- 短回复：直接回消息
- 长回复：分段发送或发送 summary + 链接

## 推荐交互模式

### 模式 1：聊天模式
用户说：
- “让 Linux 的 codex 和 Windows 的 researcher 讨论一下这个需求”

平台执行：
- 创建 cross-gateway conversation
- 等待结果
- 回发 transcript 或 summary

### 模式 2：会议模式
用户说：
- “开个三人会：main、coder、qa，讨论这个 bug”

平台执行：
- 创建 meeting
- 按轮次调度 agents
- 最后回 summary

### 模式 3：控制台模式
用户说：
- “查看当前 Gateway 状态”
- “刷新 Linux Gateway agents”
- “列出 Windows 可用 agents”

平台执行：
- 读取数据库 / 调用刷新接口
- 回发结构化状态

## 数据与系统设计建议

### 平台侧需要新增的东西
1. Feishu Adapter
- 验签
- 接收消息事件
- 发送消息
- 处理群 / 私聊上下文

2. Feishu Conversation Mapping
- Feishu `chat_id` / `open_id` / `message_id`
- 对应平台 `conversationId` / `meetingId`

3. Message Formatter
- 平台 transcript 转 Feishu 文本
- summary 卡片化

### 关键对象建议
- `FeishuChannel`
- `FeishuConversationBinding`
- `Conversation`
- `Meeting`
- `MeetingParticipant`
- `MeetingEvent`

## 多 Gateway bot 现有资产怎么处理

### 短期建议
- 先不要依赖它们在同一群里互聊
- 把它们当作“Gateway 自己已有的独立入口”
- 平台级 Feishu bot 作为新的统一入口

### 中期建议
- 可以让平台读取各 Gateway Feishu bot 的状态
- 但最终统一编排仍由平台掌握

## 平台是否能帮助现有问题
答案是：可以，但不是用“让 bot 自己聊 bot”的方式解决。

平台真正能提供的是：
- 跨 Gateway Agent 编排
- transcript 管理
- 会话持久化
- 多 Agent 轮次控制
- 统一的 Feishu 输出入口

所以平台能解决“协作”问题，但不是简单地让两个 Feishu bot 在群里自动互相回复。

## 推荐实施阶段

### 阶段 1：Feishu 只做平台通知/查看
- 手机上看状态
- 看最近会话
- 看 Gateway / agent 状态

### 阶段 2：Feishu 发起平台对话
- 在群里触发 single-agent / cross-gateway chat
- 平台回 summary 或 transcript

### 阶段 3：Feishu 发起 meeting
- 在群里创建多 Agent 会议
- 平台在后台编排
- 结束后回 summary

## 第一版验收标准
- 用户可通过 Feishu 查看平台状态
- 用户可从 Feishu 发起一次跨 Gateway 对话
- 平台能把结果回发到 Feishu
- 不依赖多个 Gateway bot 在群里互相触发

## 当前推荐的新会话起手顺序
1. 先做页面信息架构改造
2. 再做平台统一 Feishu 入口
3. 最后再考虑如何和现有 Gateway bot 共存

## 2026-03-21 当前衔接点
- 页面信息架构改造第一阶段已完成：
  - Dashboard 现在主要保留监控、状态和入口
  - `/chat` 已成为真实 cross-gateway conversations 入口
  - `/gateway-tools` 已单独承接 Gateway 联调能力
- 因此接下来的 Feishu 接入，可以默认围绕“平台统一入口 -> 平台 conversation/orchestrator -> Gateway agents -> 回发 Feishu”这条主链路实现。
- 当前不需要再把精力放回“多个 Gateway bot 在同一个 Feishu 群里直接互相触发”这条方向。

## 给下一个接手 Agent 的说明

### 你现在接手时，应该先知道什么
- 当前项目的底层能力已经不是主要阻塞点。
- 多 Gateway 注册、OpenClaw token 配置、跨 Gateway chat、远端 agent 刷新都已经打通。
- 当前最重要的是把“能用的原型”整理成“正确的产品结构”。

### 你这轮接手的推荐目标
不要一上来继续扩展底层 WS / OpenClaw / Prisma 能力，优先做下面两件事：

1. 先推进页面信息架构改造
- 把真实对话区从 Dashboard 迁到单独的 Chat / Conversations 页面
- 让最新消息优先可见
- Dashboard 只保留监控、状态、入口

2. 再设计平台统一 Feishu 入口
- 不要尝试让多个 Gateway bot 在同一个群里直接互相触发聊天
- 要把 Agent Platform 作为中间编排层
- Feishu 作为用户入口和展示面

### 你不应该误判的事情
- `OpenClaw Gateway Console` 更像联调工具，不是最终聊天主界面。
- `Cross Gateway Chat` 现在虽然放在 Dashboard，但它已经更接近正式会话能力，不应该长期留在这个位置。
- 现有每个 Gateway 各自的 Feishu bot，不等于平台级多 Agent 协作入口。
- 平台能解决的是“跨 Gateway 编排”，不是简单让 bot 在群里自己互聊。

### 你接手前建议先读这些文件
按顺序读，先建立正确上下文：

1. `docs/04_HANDOVER.md`
2. `docs/08_OPENCLAW_HTTP_HANDOVER.md`
3. `docs/09_CROSS_GATEWAY_AGENT_CHAT_HANDOVER.md`
4. `docs/10_LAYOUT_AND_FEISHU_HANDOVER.md`
5. `docs/11_DASHBOARD_CHAT_LAYOUT_PLAN.md`
6. `docs/12_FEISHU_PLATFORM_INTEGRATION_PLAN.md`

### 如果你要开始写代码，建议先看这些实现文件
1. `src/app/page.tsx`
- 当前 Dashboard 总入口，能看出页面职责是怎么混在一起的

2. `src/components/dashboard/CrossGatewayChatPanel.tsx`
- 当前跨 Gateway chat UI
- 后续迁到 Chat Room 时，大概率要复用里面不少逻辑

3. `src/components/dashboard/OpenClawGatewayConsole.tsx`
- 当前 Gateway 配置/联调入口
- 后续可能单独拆页

4. `src/app/api/gateways/chat/route.ts`
- 当前跨 Gateway chat 后端主逻辑
- 也是之后 Chat Room / Conversations 的核心后端基础

5. `src/app/api/gateways/[id]/agents/refresh/route.ts`
- 当前远端 agent 刷新入口

6. `src/lib/openclaw-gateway-rpc.ts`
- 平台通过 WS 控制面读取远端 `agents.list` 的关键实现

7. `src/lib/openclaw-client.ts`
- 平台通过 OpenClaw HTTP `/v1/responses` 调用 agent 的关键实现

### 推荐你下一步怎么推进
最优先路线：

1. 新建 `/chat` 或 `/conversations`
2. 先把 `CrossGatewayChatPanel` 挪过去
3. 在 Dashboard 只保留入口卡片
4. 然后再开始设计 Feishu 平台统一入口

### 这轮最重要的产品判断
- 先整理“界面和入口”
- 再做“手机上的统一入口”
- 最后再做“Feishu 上的多 Agent meeting”
