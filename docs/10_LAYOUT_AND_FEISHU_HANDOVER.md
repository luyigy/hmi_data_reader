# 10 Layout And Feishu Handover

## 当前阶段结论
- 多 Gateway 注册、OpenClaw HTTP 调用、跨 Gateway Agent Chat、远端 agent 刷新都已经打通。
- 当前产品层面最大的短板，不再是“能不能通”，而是“怎么让用户顺手地用”。
- 下一个阶段不建议继续堆底层功能，而应该先做两件事：
  - 重构 Dashboard / Chat 的页面布局与交互分工
  - 设计并落地平台级 Feishu 接入方案

## 2026-03-21 已落地进展
- Dashboard 已移除 `CrossGatewayChatPanel` 和 `OpenClawGatewayConsole` 主内容区。
- `/chat` 已改成正式的 `Cross-Gateway Chat Room` 入口，并直接复用现有跨 Gateway 会话面板。
- 新增 `/gateway-tools` 页面承接 `OpenClaw Gateway Console`，明确其“联调工具”定位。
- 侧边栏导航已增加 `Gateway Tools`，并将 `/chat` 明确命名为 `Chat Room`。
- 这意味着页面信息架构第一阶段已经完成，下一阶段可以继续在此基础上推进平台统一 Feishu 入口。

## 2026-03-21 Feishu 接入补充判断
- 已确认 OpenClaw 官方 Feishu 扩展存在原始源码，不是黑盒产物。
- 本机源码路径：
  - `~/.local/share/pnpm/global/5/.pnpm/openclaw@2026.3.13_.../node_modules/openclaw/extensions/feishu`
- 官方实现使用：
  - `@larksuiteoapi/node-sdk`
  - `websocket` / `webhook` 双模式
  - `verificationToken` + `encryptKey` 的 webhook 安全模型
- 这意味着平台侧下一轮做 Feishu 统一入口时，不应继续停留在“最小 fetch 版 webhook”层面，而应尽量向 OpenClaw 官方实现对齐。
- 推荐下一轮 Feishu 接入优先事项：
  1. 对齐 `@larksuiteoapi/node-sdk`
  2. 新增 `FEISHU_ENCRYPT_KEY`
  3. 补齐 webhook 签名校验、解密、挑战处理
  4. 在安全闭环之上保留平台自己的 `/ap status`、`/ap gateways`、`/ap chat` 路由能力

## 为什么现在先做布局，而不是继续堆功能
当前 Dashboard 页面同时承载了 3 类完全不同的职责：

1. 平台监控
- `Agent 平台监控看板`
- `Agents` 列表

2. Gateway 配置与联调
- `OpenClaw Gateway Console`
- token 配置
- 单 Gateway 测试调用

3. 真实多 Gateway 对话
- `Cross Gateway Chat`
- transcript
- 历史会话

问题在于：
- 监控信息适合 Dashboard
- 配置/联调适合单独的工具页或开发者页
- 真正的会话 transcript 不适合放在页面下半段
- 用户为了看最新消息要一直往下滚，这和常规聊天产品的心理模型是冲突的

一句话：
- 现在“功能通了”，但“信息架构还不对”。

## 当前推荐的产品方向

### Dashboard 应该保留什么
- 平台概览
- Gateway / Agent 当前状态
- 快速入口
- 少量关键操作按钮

### Dashboard 不应该继续承载什么
- 长 transcript
- 长时间停留的实时会话窗口
- 多轮聊天主界面

### `OpenClaw Gateway Console` 的定位
- 它本质上是“联调工具”
- 更适合放在：
  - `Gateway Tools`
  - `Developer Console`
  - 或单独 `Gateway Detail` 页面

### `Cross Gateway Chat` 的定位
- 它已经不只是“测试按钮”
- 它更像：
  - 多 Agent 对话入口
  - transcript 入口
  - meeting 的前置形态
- 因此更适合迁移到：
  - `Chat Room`
  - 或一个新的 `Conversations` 页面

## Feishu 方向的核心判断
用户现在已经有“每个 Gateway 各自的 Feishu bot”，但这些 bot 即使在同一个群里，也不能自然互相对话。

这是正常现象，不是平台坏了。原因通常包括：
- 机器人平台本身不鼓励 bot-to-bot 互相触发
- 群消息路由以“用户触发”为主，而不是“机器人之间自由对话”
- 即使两个 bot 在同一个群里，也不会天然形成一个可控的多 Agent 编排系统

所以正确方向不是：
- 继续尝试让多个 Feishu bot 在同一个群里“自然自己聊起来”

而是：
- 让 Agent Platform 成为中间编排层
- Feishu 作为“输入/输出界面”
- Gateway Agents 作为“执行者”

## 平台在 Feishu 里的推荐角色
- 平台应该成为“会议主持人 / 会话桥接器”
- Feishu 侧最好有一个统一入口，而不是让每个 Gateway bot 自己抢着说话

推荐结构：

1. Feishu 用户
- 在群里发起问题 / 任务

2. Agent Platform
- 接收 Feishu 事件
- 创建 conversation / meeting
- 决定找哪个 Gateway / agent
- 收集回复
- 把整理后的内容再发回 Feishu

3. 各 Gateway Agent
- 不直接在 Feishu 群里互相喊话
- 而是通过平台 API / orchestrator 交流

## 下一阶段工作顺序
1. 先完成页面信息架构重整
- 把 Dashboard、Gateway Console、Chat Room 的边界划清

2. 把真实 transcript 迁移到 Chat Room / Conversations
- 保证“最新消息优先可见”

3. 再设计 Feishu 平台入口
- 先做平台统一入口 bot
- 再决定是否保留每个 Gateway 自己的 bot

4. 最后再做 Feishu 上的多 Agent meeting 体验
- 群里发起
- 平台编排
- 群里回显

## 本阶段建议新会话起手阅读
1. `docs/04_HANDOVER.md`
2. `docs/09_CROSS_GATEWAY_AGENT_CHAT_HANDOVER.md`
3. `docs/10_LAYOUT_AND_FEISHU_HANDOVER.md`
4. `docs/11_DASHBOARD_CHAT_LAYOUT_PLAN.md`
5. `docs/12_FEISHU_PLATFORM_INTEGRATION_PLAN.md`
