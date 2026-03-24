# 26 ACPX Clean Chat Layout And Collapsible Panels Handover

## 日期
2026-03-24

## 背景
在 `25_ACPX_ONE_CLICK_AGENT_RIGHTS_ESCALATION_HANDOVER.md` 之后，task room 的功能面已经继续增强：
- chat-first / session-first 主路径已经接通
- active run 与 selected run 的控制语义已经拆开
- 一键授权 agent 的入口也已经补上

但真实页面继续暴露出新的主问题：
- 聊天主区仍然不够干净
- 与聊天无关的大量状态 pills 和说明挤占了对话空间
- 右侧 run history / summary 是常驻的，压缩了主聊天宽度
- 左侧全局导航也是固定展开的，进一步占掉横向空间

用户现在要的不是继续往当前页面上叠更多提示，
而是把 task room 真正收敛成一个：
- chat first
- 默认简洁
- 需要时再展开更多控制与状态信息

## 用户最新明确诉求

用户这次明确希望把以下内容移出聊天主区，放到可折叠或可切换区域：

### 1. 顶部和“对话”区里的大量状态 pills / hint
包括但不限于：
- `聊天优先布局已启用`
- `Profile: Full Access`
- `Sandbox: danger-full-access`
- `Network: enabled`
- `Approval: on-request`
- `Sandbox: 已应用`
- `Approval: 部分应用`
- `Network: 仅记录`
- `Writable Roots: 仅记录`
- `implementer · Local / codex`
- `reviewer · Windows Gateway 10.0.8.3 / claude`
- `当前查看：Run 29（completed）`
- `当前还没有可控制的 Run`
- `当前浏览的是历史 run；控制按钮不会作用于它`
- `control normal`
- `run sandbox workspace-write`
- `run network restricted`
- `run approval never`
- `run sandbox 已应用`
- `run approval 部分应用`
- `run network 仅记录`
- `run writable roots 仅记录`
- `same Codex session confirmed · ...`
- `聊天模式下会优先继续 ...`

这些信息并不是都不重要，
而是当前全部同时常驻在聊天上方，已经明显破坏“对话优先”的观感。

### 2. 右侧 Run History 需要可折叠
当前问题不是 run history 不需要，
而是它默认常驻并持续压缩聊天宽度。

用户明确要求：
- run history 可以 collapse

这意味着它更适合变成：
- 可折叠右栏
- 或抽屉
- 或 tabs / segmented panel 中的一个区块

而不是永远固定展开。

### 3. 左侧导航栏也需要可切换
当前全局 sidebar 在 [Sidebar.tsx](/data1/code/agent-platform-v2/src/components/common/Sidebar.tsx) 中固定 `w-64` 展开，
对于 task room 这种以对话为主的页面来说过于占横向空间。

用户明确要求：
- left navigation sidebar toggleable

这说明 task room 页面已经开始接近“沉浸式工作区”诉求，
而不是传统 dashboard 页。

## 当前更准确的问题判断

### 1. 页面现在的问题不是“信息不够”，而是“默认展开的信息太多”
当前页面已经能表达很多状态，
但问题在于：
- 所有元信息都默认展开
- 并且很多信息在同一视觉层级里竞争注意力

结果就是：
- 主聊天区被压扁
- 消息内容不再是第一视觉焦点
- 页面更像一个控制台，而不像一个对话界面

### 2. task room 需要区分“默认工作态”和“检查细节态”
更合理的产品模型应该是：

#### A. 默认工作态
用户主要做的是：
- 看消息
- 发消息
- 让 agent 回复
- 适度控制 active run

这一态下应该尽量干净，
只保留最必要的信息。

#### B. 检查细节态
用户需要时再查看：
- run metadata
- permission details
- session tracking
- run history
- selected run summary

这一态下再展开更多 side panel / drawer / details card。

### 3. “可见性层级”需要重新设计
当前信息大致可以分三层：

#### 第一层：默认始终可见
只保留最关键的少量信息，例如：
- 当前任务名
- 聊天模式 / 执行模式
- 当前是否有 active run
- 主操作按钮

#### 第二层：轻量摘要，可收起
例如：
- 当前查看的是哪条 run
- 当前控制目标
- 当前 session 是否可 continuation
- 当前权限 profile 摘要

#### 第三层：详细元数据，只在需要时展开
例如：
- sandbox / network / approval 各项状态
- participant 列表
- session tracking thread id
- run-specific permission support
- selected run summary
- 完整 run history

当前主要问题是：
- 第二层和第三层的信息被大量放进了第一层。

## 推荐产品方向

### 原则 1. 聊天区顶部只保留一个“精简状态条”
默认只展示少量必要信息，例如：
- `当前查看：Run 29`
- `当前控制：无 active run`
- `模式：聊天模式`

其他所有详情统一折叠到：
- `查看详情`
- `运行信息`
- `会话信息`
- `权限详情`

这样的可展开区域里。

### 原则 2. 右侧改为“可折叠检查面板”
右侧栏建议统一成一个可折叠面板，
内部再包含：
- Run History
- Selected Run Summary
- Participant Outcomes

默认：
- 展开聊天主区
- 右栏可关闭

需要排查时：
- 再展开右栏

### 原则 3. 左侧导航需要支持收起
建议把全局 sidebar 改成：
- 展开态：保留现在的品牌和菜单
- 收起态：只保留图标窄栏

在 task room 页面里最好还能做到：
- 默认更紧凑
- 用户一键展开 / 收起

### 原则 4. 不要把“说明文案”长期挂在聊天主区
像：
- `聊天模式下会优先继续...`
- `当前浏览的是历史 run...`

这类内容更适合：
- tooltip
- details 面板
- info drawer
- 或首次提示后可关闭

而不是长期常驻在消息流上方。

## 建议实施计划

### Phase 1. 先把聊天主区的元信息收拢到一个可切换的 `Room Details`
目标：
- 从聊天主区顶部移走大部分 pills
- 只保留极少数必要摘要
- 把 run / permission / session / participant 细节收进一个折叠区

建议形态：
- 顶部一行 `房间详情` 按钮
- 点开后出现一个 drawer / accordion / popover

### Phase 2. 把右侧栏改成可折叠 workspace inspector
目标：
- 让 `Run History`
- `Selected Run Summary`
- `Participant Outcomes`

都进入一个统一的右侧 inspector

要求：
- 可展开 / 可收起
- 收起后聊天主区拿回宽度
- 展开状态最好可保存在 localStorage

### Phase 3. 给左侧全局导航增加 collapse
目标：
- 在全局 layout 层新增 sidebar collapse state
- 支持图标-only 窄栏
- task room 页面能获得更大的横向空间

涉及文件初步判断：
- [layout.tsx](/data1/code/agent-platform-v2/src/app/layout.tsx)
- [Sidebar.tsx](/data1/code/agent-platform-v2/src/components/common/Sidebar.tsx)

### Phase 4. 清理聊天页的默认文案密度
目标：
- 把长说明文案挪到 tooltip / details / drawer
- 默认只保留短标签或图标化摘要
- 系统信息卡片也进一步轻量化

## 实施时的注意点

### 1. 不要为了“干净”而丢掉关键控制语义
例如：
- active run vs selected run
- continuation 可用性
- 当前权限 profile

这些仍然要保留，
只是不能继续以大面积常驻 pills 的方式出现。

### 2. 折叠逻辑应优先保存用户偏好
例如：
- 左侧导航是否收起
- 右侧 inspector 是否展开
- room details 是否展开

这些都适合存在浏览器本地。

### 3. 移动端和窄屏要优先受益
这次改动的价值不只是桌面端更干净，
更重要的是：
- 窄屏下聊天主区终于能成为主角

## 一句话结论
下一阶段 task room 不应再继续把更多 run / permission / session 元信息堆进聊天上方，
而应切到：
- 聊天主区默认简洁
- 详情信息按需展开
- 右侧 run inspector 可折叠
- 左侧导航可收起

这样 task room 才会真正从“控制台式页面”收敛成“对话式工作区”。
