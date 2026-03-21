# 11 Dashboard Chat Layout Plan

## 目标
- 让 Dashboard 回到“监控面板”的角色
- 让真实对话回到“聊天界面”的角色
- 避免用户为了看最新消息而一直滚到页面底部

## 当前页面存在的问题

### 1. 一个页面承载了 3 种完全不同的任务
- 平台监控
- Gateway 配置 / 联调
- 实时对话

### 2. transcript 放在页面下半段，违背聊天产品常识
- 最新消息应该始终优先可见
- 现在用户必须滚到很下方，才能看到最新一轮回复

### 3. `OpenClaw Gateway Console` 和 `Cross Gateway Chat` 混在 Dashboard 中，角色不清
- Console 更像测试/运维工具
- Cross Gateway Chat 更像真实业务界面

## 产品信息架构建议

### 页面 1：Dashboard
保留：
- 平台概览卡片
- Gateway / Agent 状态
- 最近告警 / 最近事件
- 快速跳转入口

移出：
- 长 transcript
- 长期使用的聊天窗口
- 面向联调的长输出区

### 页面 2：Gateway Console
定位：
- 开发/运维联调工具页

保留：
- Gateway 列表
- OpenClaw token 配置
- Gateway health/test
- 单 Gateway prompt test
- agent refresh

说明：
- 这里可以保留“测试输出”
- 但它不应该承担正式聊天产品的主会话体验

### 页面 3：Chat Room / Conversations
定位：
- 真正的多 Gateway / 多 Agent 对话页面

应该承载：
- 会话列表
- 当前 transcript
- 最新消息优先
- 输入框固定在底部
- 会话切换
- 继续当前会话

## Chat Room 推荐布局

### 左侧栏
- 会话列表
- 可按：
  - 最近更新时间
  - 参与 Gateway
  - 参与 agent
  - 状态

### 中间主区域
- 当前 transcript
- 最新消息自动滚动到底部
- 顶部显示：
  - 当前会话名
  - 参与 Gateway
  - 参与 agent
  - 当前轮数 / 状态

### 底部输入区
- prompt 输入框
- 发送按钮
- 轮次选择
- 续聊 / 新会话切换

### 可选右侧栏
- 会话元信息
- Gateway / agent 详情
- 调试信息

## `OpenClaw Gateway Console` 与 `Cross Gateway Chat` 的关系

### `OpenClaw Gateway Console`
- 保留为测试工具
- 用于：
  - 验证 token
  - 测试某个 Gateway 的单次响应
  - 联调健康状态

### `Cross Gateway Chat`
- 应迁移成 `Chat Room` 的核心能力
- 不再放在 Dashboard 下面长长地堆着

## 实施建议

### 阶段 1：先挪位置，不大改能力
- Dashboard 中移除 `Cross Gateway Chat`
- 新建 `/chat` 或 `/conversations`
- 先把现有 `CrossGatewayChatPanel` 移过去

### 阶段 2：改成真正聊天布局
- transcript 区域撑满主视图
- 输入框固定底部
- 左侧加会话列表
- 自动滚动到最新消息

### 阶段 3：再考虑把 `OpenClaw Gateway Console` 单独拆页
- 例如：
  - `/gateway-tools`
  - `/gateway-console`

## 验收标准
- 用户打开 Dashboard，不需要看到长 transcript
- 用户打开 Chat Room，第一眼看到最新消息而不是旧消息
- 切换会话后能立即看到对应 transcript
- 续聊时不需要回到 Dashboard 底部操作

## 下一步最小实现建议
1. 新建 `/chat` 页面
2. 复用现有 `CrossGatewayChatPanel`
3. 在 Dashboard 上只保留跳转入口卡片
4. 先实现“会话列表 + transcript + 输入框”三段式布局

## 2026-03-21 实施状态
- 阶段 1 已完成：
  - `/chat` 已承接 `CrossGatewayChatPanel`
  - Dashboard 已去掉长 transcript，改为状态与入口页
  - `OpenClaw Gateway Console` 已拆到 `/gateway-tools`
- 阶段 2 仍待推进：
  - `CrossGatewayChatPanel` 目前还是沿用原组件形态
  - 还没有独立的左侧会话列表栏与固定底部输入区
  - 下一步应把 `/chat` 进一步收敛成真正的 conversations 布局
