# 30 ACPX Live Room Mention 与 Agent 间直聊方案交接

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

### 当前 agent “看得到别人”，但“不能真正和别人说话”
具体表现是：
- agent 能从 transcript 中读到别的 agent 的存在
- agent 也会在文本里说“我能和 researcher 沟通”
- 但当它在自己的回复里点名 researcher 时，
  researcher 不会自动收到一个“你被某个 agent 明确发言/提问了”的独立信号

这说明当前系统仍然主要是：
- `user -> selected speaker -> reply`

而不是：
- `room member A -> room member B`

也就是说，
现在的 Live Room 还只是“用户主导的多 agent 聊天视图”，
还不是“agent 之间可定向交互的真实房间”。

## 当前实现的真实边界

### 1. transcript 共享 != member-to-member messaging
现在所有 member 共享同一条 transcript，
这解决的是：
- 大家看得到历史
- 大家知道房间里有谁

但没解决：
- A 要明确叫 B 回答时，系统如何识别“B 是目标”
- B 是否应该立刻获得更高优先级的投递
- B 回复后是只回给 A，还是仍然回到整个 room

换句话说，
共享 transcript 只是“共同上下文”，
不是“定向通信协议”。

### 2. 现在的 dropdown 仍然是用户路由器，不是 mention 体系
当前 composer 上的目标下拉框，
本质是在做：
- 用户手动选择“下一位优先回复者”

它解决的是：
- 用户知道要点谁来答

但不解决：
- agent 在回复里如何点名别人
- agent-to-agent 的消息如何有目标、有优先级、有审计

所以：
- dropdown 不应该被 mention 完全替代
- 它和 mention 的职责不同

### 3. agent-to-agent 对话需要“路由语义”，不是只靠 prompt 猜
如果只依赖模型从自然语言里理解：
- “Hi researcher”
- “请 researcher 回一下”

会有三个问题：
- 命中不稳定
- 同名 agent 难区分
- 无法表达“只对某 agent 说”还是“在房间里公开点名某 agent”

所以后续必须把 mention 从“文案提示”升级成：
- message metadata
- delivery intent
- member routing

## 推荐的产品模型

### 模型 A. dropdown 继续保留，作为“显式强路由”
dropdown 适合处理：
- 用户明确指定谁来答
- 用户不想靠 mention 解析
- 同名 agent 很多时，用户需要唯一、稳定、可视化地选目标

它的产品定位应是：
- `下一条消息优先投递给谁`

也就是：
- user-side routing control

### 模型 B. mention 负责“自然语言中的定向指向”
mention 适合处理：
- 用户在自然语言里直接 `@researcher`
- agent 在回复里 `@main`
- room 内多人协作时更自然的交流方式

它的产品定位应是：
- `消息文本中的目标引用`

也就是：
- semantic routing hint

### 模型 C. agent-to-agent 直聊必须写成 room message，但带 target metadata
推荐统一模型：
1. 任意 member 发言先写入 room message
2. 若存在 mention target，则写入：
   - `mentionedMemberIds`
   - `primaryTargetMemberId`
   - `deliveryIntent = mention`
3. delivery 层根据 metadata 决定下一跳
4. 被点名 agent 的回复仍然回到 room

这样可以同时保留：
- 审计
- room 可见性
- 明确的下一跳路由

## 为什么 agent 现在“不能真正互相说话”

### 根因 1. 缺少 member-to-member message intent
当前 message 虽然在 room 内可见，
但没有把以下结构稳定存下来：
- 谁在说
- 说给谁
- 是公开说，还是点名说

于是 delivery 层只能继续按：
- current speaker
- 用户 dropdown target

来决定下一位答复者。

### 根因 2. agent 的“点名行为”没有一等公民语义
现在最多只能做文本识别：
- 从内容里猜有没有提到别的 member

这只能算过渡能力，
不能作为最终协议。

最终应该让 agent 输出时能伴随更结构化的信号，例如：
- message metadata 里带 mention target
- 或通过 tool / room action 明确声明：
  - `reply_to_member`
  - `ask_member`
  - `handoff_to_member`

### 根因 3. 没有“下一跳发言权”模型
agent-to-agent 沟通不是简单的 `A 说一句，B 也看到`。

真正缺的是：
- A 点名 B 后，
- 系统是否把“当前 speaking priority”切给 B

如果没有这个 speaking token / priority 概念，
B 就算看到了，也不会被系统自动调度成下一位回应者。

## 推荐的实现方向

## Phase 1. 先做“真实 mention metadata”，不要只靠字符串匹配
建议为 room message metadata 新增标准字段：
- `mentionedMemberIds: string[]`
- `primaryTargetMemberId: string | null`
- `deliveryIntent: user_target | mention | broadcast | handoff`
- `senderKind: user | assistant | system`

这样：
- dropdown 选人会落到 `user_target`
- `@agent` 会落到 `mention`
- later 可以支持 `@all`

### 这一阶段 UI 要做什么
- composer 中支持 `@` 自动补全 member
- 选择 mention 后，文本中插入稳定 label
- 同时 metadata 保存 member id，而不是只保存展示名

这一步非常关键，因为它是解决“同名 main 无法区分”的根本方式。

## Phase 2. 新增“下一跳调度规则”
delivery 不应再只认当前 speaker。

推荐优先级：
1. `primaryTargetMemberId`
2. 最新 mention target
3. current speaker
4. fallback default responder

这样：
- 用户点名 researcher，researcher 先答
- Codex 在回复里 `@researcher`，researcher 会自动成为下一跳
- 没有点名时，才回到 current speaker

## Phase 3. 引入 `handoff` 与 `ask` 两种 agent 意图
agent-to-agent 对话不应永远只靠普通自然语言消息。

建议区分至少两种意图：

### `ask`
含义：
- A 向 B 提一个问题
- B 回完后，房间不一定永久切 speaker

### `handoff`
含义：
- A 主动把下一步交给 B
- 系统应直接切换 current speaker 为 B

这两者如果不区分，
后续会出现很多混乱：
- 到底只是点名问一句
- 还是正式把下一阶段交出去

## Phase 4. 再决定是否保留 current speaker dropdown
答案是：
- 保留

但它应被重新定义为：
- “默认回复者”
- 或“当前房间主持 / 主回复 agent”

而不是“唯一可回复对象”。

### 最终关系应该是
- dropdown：默认 speaker / 手动强切换
- mention：单条消息级的定向路由
- handoff：把默认 speaker 永久切到另一个 member

这三者不是替代关系，而是分层关系。

## 关于“agent 怎样真正互相说话”的更准确答案

### 当前还没有真正做到
现在最多只能算：
- 同 room 可见
- 可被 transcript 感知
- 有有限的基于文本命中的下一跳尝试

这还不是完整的 agent-to-agent messaging。

### 真正做到需要三件事同时成立
1. 消息里有明确 target metadata
2. delivery 层认 target，而不是只认 current speaker
3. room 里有 speaking token / handoff 语义

少任意一个，都仍然只是在“共享上下文”，
不算真正直聊。

## 建议的下一轮开发顺序

1. 先给消息加结构化 mention metadata
2. 做 composer 的 `@member` 自动补全
3. 让 dropdown 与 mention 共存，而不是互相替代
4. 重写 delivery 优先级，先认 target / mention，再认 current speaker
5. 增加 `handoff_to_member` 语义
6. 最后再考虑多 agent 并发说话与更复杂的 room orchestration

## 本轮已先做的小修
为了降低当前使用误判，本轮已把消息头部往“可识别来源”方向推进：
- message header 应显示 sender 的 gateway/local + harness 来源
- 避免两个 `main` 或两个 `claude` 在消息流中不可区分

但这只是可视化止血，
不是完整 mention / agent-to-agent 协议。

## 给下一位会话的结论
下一步不要只继续 patch 文本识别。

真正该做的是：
- 把 mention 升级成结构化 message target
- 把 room delivery 从“current speaker 单线程回复”升级成“target-aware routing”
- 把 dropdown 重定义成默认 speaker，而不是唯一路由器

一句话总结：
只有当 room message 拥有稳定的 member target metadata，
并且 delivery 层真正按这个 target 调度下一跳时，
agent 才算真正能在这个 room 里彼此说话。
