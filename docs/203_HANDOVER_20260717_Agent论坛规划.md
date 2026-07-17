# 203_HANDOVER_20260717_Agent论坛规划

## 任务类型
docs / feature planning

## 所属主线
支线任务：异步多 Agent 协作界面

## 为什么做
现有 Live Room 适合即时对话和顺序执行，但不适合长期保留一个主题下的结构化回帖。计划增加类似传统 BBS 的 Agent Forum：用户发布主题，选定 agent 参与，agent 以持久化回帖交流或协作。

本轮只记录方案，不实现代码、数据库或 UI。

## 目标体验
- `/forum` 展示主题列表，主题有独立稳定 URL。
- 用户创建主题时选择参与成员、角色、权限和回复模式。
- 帖子按主题组织，支持回复用户、回复 agent、引用指定帖子。
- 用户可触发单个 agent、全部 agent 或下一轮讨论。
- Agent 间允许定向回复，但自动往返必须有明确轮次上限。

## MVP 范围
### 数据模型
- `ForumTopic`：标题、正文、状态、创建者、参与成员、当前轮次和自动轮次上限。
- `ForumPost`：主题、作者类型/成员、正文、父帖、引用帖、状态和执行记录。
- 参与成员复用 Live Room 的 agent catalog、role 和成员权限语义，不复制 harness 配置。

### 页面
- `/forum`：主题列表、新建主题。
- `/forum/[topicId]`：楼主帖、按时间排列的回帖、引用关系和执行状态。
- 操作仅包含：回复、Ask agent、Ask all、Run next round、Close topic。

### 回复模式
- `open`：只有用户明确点名或点击 Ask agent 时执行。
- `roundtable`：选中的 agent 每轮各回复一次，按既有 role 顺序执行。
- `execution`：按 `planner → researcher → implementer → reviewer → tester → custom` 执行。

### 调度约束
- 每个 agent 每轮最多一个自动回帖。
- 默认最多三轮自动协作，下一轮由用户显式触发。
- 单个 topic 同时只运行一个调度队列。
- 定向回复使用 target lock，禁止默认 speaker 抢答。
- 达到轮次、上下文或失败阈值后暂停并等待用户。

## 复用现有能力
- Agent catalog、harness adapter 和 ACPX runner。
- Live Room 的成员身份、角色顺序、成员权限和 target lock。
- continuation、上下文 watermark、执行状态和 Feishu agent 别名。
- Forum 只新增异步主题/帖子语义，不复制执行器。

## 不复用的部分
不把 `LiveRoomMessage` 直接当论坛帖子。聊天室是线性、即时的；论坛需要稳定父帖/引用关系、分页、关闭状态和永久链接。Forum 应使用独立的 Topic/Post 表，通过共享 delivery/service 调用现有 agent 执行能力。

## 实施阶段
1. 建立 `ForumTopic`、`ForumPost` 和 topic-member 关系及迁移。
2. 实现主题列表、发帖、用户回帖和分页，不接 agent。
3. 接入单 agent 定向回帖与成员权限。
4. 接入 roundtable/execution 队列及轮次限制。
5. 增加 Feishu 主题摘要/链接通知；不在首版复制完整论坛 UI 到飞书。

## 验收标准
- 用户能创建主题并获得稳定 URL。
- 用户能指定一个 agent 回帖，其他 agent 不抢答。
- roundtable/execution 顺序可预测，刷新页面不会重复调度。
- 自动 agent-to-agent 回复不会超过配置轮数。
- 关闭主题后不能继续自动执行，但历史帖子仍可阅读。
- 每个 agent 的权限、失败状态和执行来源可追踪。

## 验证结果
- 本轮仅完成方案记录。
- 未修改应用代码、数据库 schema 或运行服务。

## 对主线的影响
不影响当前 Live Room / Feishu 主线。后续实现应复用已完成的成员权限与 mode scheduler，避免形成第二套 agent execution path。

## 下一步建议
只有在决定启动该支线时，再先实现“纯用户论坛 + 单 agent 定向回帖”的最小版本。多轮自治和 agent 社交行为延后到有真实使用反馈后。
