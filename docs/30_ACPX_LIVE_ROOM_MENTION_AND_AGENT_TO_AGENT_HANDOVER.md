# 30 ACPX Live Room Mention 与 Agent-to-Agent Handover 交接

## 日期
2026-03-25

## 背景
在 `29_ACPX_MULTI_AGENT_LIVE_CHAT_ROOM_PLAN_HANDOVER.md` 第一阶段落地后，
新的 `/rooms/[id]` 已经具备：
- 独立 Live Room
- room member
- room message
- current speaker
- 用户向指定 agent 发消息并获得回复

但真实测试暴露出一个更深层的问题：

## 当前问题的准确表述

### 现在的 agent 是“共处一室”，不是“彼此可直聊”
当前系统已经能做到：
- agent 能从 transcript 看见其他 member
- agent 会在回答里提到其他 agent
- room 中所有消息都有共享可见性

但还做不到：
- A 在消息里点名 B 时，B 能收到一个明确、结构化、可路由的目标信号
- delivery 层把下一次发言优先级切给 B
- B 的回复以“被 A 点名后的响应”身份进入 room，而不是继续按旧的默认 speaker 逻辑处理

换句话说，
当前系统仍然主要是：
- `user -> selected speaker -> reply`

而不是：
- `room member A -> room member B -> room`

所以，
现在的 Live Room 还只是“多 agent 共享上下文的聊天界面”，
还不是“支持 agent 间定向交流的真实房间协议”。

## 当前实现的真实边界

### 1. transcript 共享不等于 member-to-member messaging
现在所有 member 共享同一条 transcript，
这解决的是：
- 所有人都能看到历史
- 所有人都知道房间里还有谁

但没解决：
- A 要明确叫 B 回答时，系统如何识别 B 是目标
- B 是否应获得更高优先级的投递
- B 的回复是回给整个 room，还是仅视为对 A 的回应
- 这次点名是普通 mention，还是正式 handoff

共享 transcript 只是共同上下文，
不是定向通信协议。

### 2. 当前 dropdown 仍然只是用户侧强路由
现在 composer 上的目标下拉框，本质是在做：
- 用户手动选择“下一位优先回复者”

它解决的是：
- 用户明确知道该点谁来答
- 用户不想依赖 mention 解析
- 同名 agent 存在时，用户需要一个稳定且可见的唯一选择器

但它不解决：
- agent 在回复里如何点名其他 member
- message 内部如何表达目标对象
- room delivery 如何做审计级别的目标投递

所以 dropdown 不应该被 mention 替代。

### 3. 只靠 prompt 或纯文本匹配无法成为最终协议
如果只依赖模型从自然语言中理解：
- `@researcher`
- `Hi researcher`
- `请 researcher 回一下`

会有三个问题：
- 命中不稳定
- 同名 agent 无法可靠区分
- 无法表达“公开点名”与“正式交接”的区别

因此 mention 必须从“文案特征”升级成：
- message metadata
- delivery intent
- member routing signal

## 这次问题的根因

### 根因 1. message 缺少稳定的 target 语义
当前 room message 虽然在房间内可见，
但系统没有稳定存下这些结构：
- 谁发送
- 说给谁
- 是广播、点名、还是交接

于是 delivery 层只能继续依赖：
- current speaker
- user dropdown target

来决定下一位回应者。

### 根因 2. agent 的“点名别人”还不是一等公民能力
现在最多只能从 message content 里猜：
- 有没有提到别的 member
- 提到的是不是某个 agent 名称

这只能作为过渡兜底，
不能作为最终协议。

最终应该让 agent 输出伴随结构化信号，例如：
- message metadata 中带 mention target
- 或通过 room action / tool 明确声明：
  - `ask_member`
  - `reply_to_member`
  - `handoff_to_member`

### 根因 3. 系统没有“下一跳发言权”模型
agent-to-agent 沟通不是简单的：
- A 说一句
- B 也看到了

真正缺失的是：
- A 点名 B 后，系统是否把 speaking priority 切给 B
- B 回答后，是否恢复默认 speaker
- handoff 后，默认 speaker 是否被永久切换

如果没有 speaking priority / handoff 语义，
B 即使“看到了”，也不会被系统自动调度成下一位回应者。

## 推荐的产品模型

### 模型 A. dropdown 继续保留，作为显式强路由
dropdown 的定位应是：
- `下一条消息优先投递给谁`

它代表的是：
- user-side routing control

适合处理：
- 用户明确指定谁来答
- 用户不想靠 mention 解析
- 同名 agent 需要唯一、稳定、可视化地选目标

### 模型 B. mention 负责自然语言中的目标引用
mention 的定位应是：
- `消息文本中的目标引用`

它代表的是：
- semantic routing hint with structured metadata

适合处理：
- 用户输入 `@researcher`
- agent 在回复里 `@main`
- 多 member 协作时更接近真实群聊心智

### 模型 C. handoff 负责默认 speaker 的正式切换
handoff 的定位应是：
- `把后续主回复权交给另一个 member`

它代表的是：
- room-level speaking ownership change

它不是普通 mention，也不是单次 ask。

## 推荐的统一消息模型

### 核心原则
任意 member 的发言都先写成 room message。
如果这条消息带目标、点名、或交接语义，则以 metadata 形式写入，而不是只留在文本里。

### 推荐字段
建议为 room message metadata 新增这些标准字段：
- `senderMemberId: string`
- `senderKind: user | assistant | system`
- `mentionedMemberIds: string[]`
- `primaryTargetMemberId: string | null`
- `deliveryIntent: broadcast | user_target | mention | ask | handoff`
- `inReplyToMessageId: string | null`
- `handoffToMemberId: string | null`

如果想继续往下扩展，可预留：
- `routingReason: string | null`
- `deliveryPriority: normal | targeted | handoff`
- `visibilityScope: room`

### 字段语义建议
- `mentionedMemberIds`
  表示文本里出现过、且已被结构化识别的 member。
- `primaryTargetMemberId`
  表示当前这条消息的主要目标对象，delivery 层优先看这个字段。
- `deliveryIntent`
  表示系统如何理解这条消息的投递语义。
- `handoffToMemberId`
  只有在 `deliveryIntent = handoff` 时才有意义。

## delivery 层的推荐规则

### 不要再只认 current speaker
delivery 的下一跳判断不应再是单一的 current speaker 模型，
而应按优先级决策。

### 推荐优先级
1. `deliveryIntent = handoff` 且存在 `handoffToMemberId`
2. `primaryTargetMemberId`
3. 最近一条 message 的 `mentionedMemberIds` 中被选为主目标的 member
4. 当前 room 的 `currentSpeakerMemberId`
5. fallback default responder

这样可以得到更符合预期的行为：
- 用户 dropdown 指定 researcher，则 researcher 先答
- 用户输入 `@researcher`，即使没选 dropdown，也能优先路由 researcher
- agent A 在回复里 `@researcher`，researcher 会成为下一跳
- agent A 发起 `handoff`，则不仅是下一跳切换，默认 speaker 也会切到 researcher

## `mention`、`ask`、`handoff` 的边界

### `mention`
含义：
- 在 message 中引用某个 member
- 可以是公开语境下的点名
- 默认不改变 room 的长期 speaker 所有权

### `ask`
含义：
- A 明确向 B 提一个问题
- B 应成为下一位优先回复者
- B 回完后，不一定永久切 speaker

### `handoff`
含义：
- A 主动把下一步交给 B
- 系统应切换 current speaker 为 B
- 这是 room 级的默认回复权转移

如果不区分这三者，
后续会频繁出现语义混乱：
- 这次只是公开点名一下
- 还是在请求某 agent 回答
- 还是已经正式把主持权交出去

## UI / Composer 层的最低要求

### Phase 1 必做
- composer 支持 `@` 自动补全 room member
- 选中 mention 时插入稳定展示 label
- 提交消息时，同时保存 member id 级别的 metadata
- dropdown 与 mention 共存，不互相覆盖

### 为什么必须保存 member id
因为展示名不是稳定标识。
只保存纯文本会带来这些问题：
- 两个 `main` 无法区分
- agent rename 后旧消息不可追溯
- delivery 无法做可靠投递

### 当前 UI 的正确心智
- dropdown：默认强路由
- mention：消息内目标引用
- handoff：更高一级的状态变更

这三者不是替代关系，而是分层关系。

## 推荐的开发顺序

### Phase 1. 先做真实 mention metadata
目标：
- 不再只靠字符串匹配
- message 写入时就带结构化 target 信息

交付物：
- room message metadata 字段落库
- composer mention 补全
- server 写入 metadata 逻辑

### Phase 2. 重写 delivery 优先级
目标：
- delivery 改为 target-aware routing
- 不再只认 current speaker

交付物：
- 按 `handoff > primaryTarget > currentSpeaker` 的优先级调度
- room 中可观察到被点名 agent 自动成为下一跳

### Phase 3. 引入 `ask` 与 `handoff`
目标：
- 让 agent-to-agent 对话语义从“自然语言猜测”升级为“系统级动作”

交付物：
- 明确的 intent 枚举
- current speaker 切换规则
- 审计上可区分 ask 与 handoff

### Phase 4. 再考虑更复杂的 room orchestration
例如：
- 多 agent 并发发言
- 轮询策略
- typing / pending state
- 被 mention 但暂时不可回复的补偿策略

这些都应该在 target-aware routing 稳定后再做。

## 最低验收标准

完成本轮后，至少应满足：
1. 用户在 room 中输入 `@researcher`，researcher 会被结构化识别并优先响应。
2. agent A 在回复里点名 `@researcher`，researcher 能自动成为下一跳。
3. 同名 agent 场景下，mention 仍然能稳定命中正确 member。
4. handoff 发生后，room 的默认 speaker 明确切换。
5. 所有目标信息都可从 room message metadata 审计出来，而不是只存在于自然语言文本中。

## 本轮结论

### 当前还没有真正做到 agent-to-agent messaging
现在最多只能算：
- 同 room 可见
- 可被 transcript 感知
- 存在有限的文本命中尝试

这还不是完整的 agent-to-agent 直聊。

### 真正做到需要三件事同时成立
1. message 中有明确 target metadata
2. delivery 层按 target 调度，而不是只按 current speaker 调度
3. room 内存在 speaking priority / handoff 语义

少任意一个，
都仍然只是“共享上下文”，
不算真正的 member-to-member communication。

## 给下一位会话的明确行动项
- 不要再继续只 patch 文本识别。
- 先把 mention 升级成结构化 message target。
- 再把 delivery 从 current-speaker-only 升级成 target-aware routing。
- 最后用 `ask` 与 `handoff` 补齐 agent-to-agent 的真正语义。

## 本轮实际已完成

### 1. room message 已具备结构化 target metadata
本轮已在 live room message 的 metadata 层补上可稳定复用的路由语义，实际包含：
- `senderKind`
- `mentionedMemberIds`
- `primaryTargetMemberId`
- `deliveryIntent`
- `inReplyToMessageId`
- `handoffToMemberId`

这意味着：
- mention 不再只是文本里出现过 `@name`
- 后端现在会把“这条消息主要说给谁”稳定写入 metadata
- 前端消息气泡也能直接看到 `mention / user_target / handoff` 等语义标签

### 2. 用户消息已改成 mention 优先，dropdown 兜底
这轮最关键的实际修复之一是：
- 如果一条用户消息已经带结构化 mention
- 那么这条消息优先按 mention 路由
- dropdown 不再覆盖 mention

之前的错误行为是：
- 用户输入了 `@researcher`
- 但如果 dropdown 仍选着别的 agent
- metadata 会被写成 `user_target`
- 最终造成“文本里明明提到 researcher，实际下一跳却不是 researcher”

现在的行为是：
- `mention > dropdown > current speaker`

### 3. composer 已支持真实 `@member` 自动补全
本轮已经补上：
- 输入 `@` 时列出 room 中可 reply 的成员
- 选中候选后，插入稳定展示名
- 同时把选中的 member id 以结构化形式带到后端

这意味着：
- mention 不再完全依赖字符串解析
- 同名 agent 也可以靠 member id 命中正确对象

### 4. mention 候选列表已修复“重要成员被截断”的问题
早期实现里，mention 下拉只显示前几个候选，
导致像 `researcher` 这种成员即使在 dropdown 存在，
也可能在 `@` 面板里看不到。

本轮已修复为：
- 空 `@` 时显示更多候选
- 输入 query 时优先按 `runtimeAgentId / displayName` 命中
- 精确匹配与前缀匹配优先级更高

### 5. agent 自动 mention 的主目标已改成“按文本出现顺序”决定
另一个关键修复是：
- 以前系统会按 member 列表顺序选择命中的第一个 agent
- 而不是按消息里真正最先出现的 `@member`

这会导致：
- 消息里写了 `@researcher`
- 但因为文本前后还出现过别的 agent label
- 最终 `primaryTargetMemberId` 可能被错误落到别的 member

本轮已改成：
- 优先识别显式 `@alias`
- 再按文本中出现位置排序
- 排在最前的 mention 成为 `primaryTargetMemberId`

这样 agent-to-agent relay 才真正稳定。

### 6. handoff 已开始进入统一语义
虽然完整的 `ask / handoff` 产品层还没完全做完，
但本轮已经把“手动切换当前 speaker”开始写成 `handoff` 语义，
这为后续把 UI 控制动作与 room routing 协议统一起来打下了基础。

## 本轮验证结论

真实调试后，已经可以稳定做到：
1. 用户输入 `@member` 时，消息按 mention 优先路由。
2. dropdown 不再覆盖结构化 mention。
3. agent 在房间中点名另一个 agent 时，下一跳可以正确落到被点名者。
4. 像 `researcher` 这类成员不会再因为候选截断而在 `@` 面板中消失。
5. `primaryTargetMemberId` 不再被 member 列表顺序误抢。

## 仍然存在的边界

当前已解决的是：
- member-to-member targeted routing
- mention 与 dropdown 的冲突
- agent mention target 的稳定命中

但还没有解决：
- 面向整个房间的 broadcast 语义
- `@all` 与普通公开发言的区别
- “公开发言时哪些 agent 应主动回复”的规则
- 新加入成员在还没发过言前，如何被 room 内其他 agent 明确感知

这些问题应进入下一份 handover 单独讨论。

一句话总结：
只有当 room message 拥有稳定的 member target metadata，
并且 delivery 层真正按这个 target 调度下一跳时，
agent 才算真正能在这个 room 里彼此说话。
