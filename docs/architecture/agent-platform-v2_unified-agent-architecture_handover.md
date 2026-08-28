# Agent Platform V2 - 统一 Agent Runtime / 消息流 / 配置体系重构说明

> 用途：作为 `luyigy/agent-platform-v2` 后续开发的架构参考与 coding agent 上下文。
>
> 本文总结近期围绕 Herdr、Agent 输出转发、统一事件流、飞书 / Web Chat Room 展示、Agent Plugin、模型与思考强度切换等问题的讨论。
>
> **重要约束：本文首先是架构方向，不要求一次性重写现有系统。优先采用渐进迁移，保留当前可工作的 Codex 路径。**

---

## 1. 背景与当前核心问题

当前平台已经支持多个 coding agent / harness，例如：

- Codex
- Claude Code
- Pi Agent
- Kimi Code
- Antigravity
- 以及未来可能新增的其他 CLI / Agent Runtime

平台希望实现两个核心能力：

1. Agent 在运行时，其回复、分析、工具调用、SubAgent 等过程可以实时显示在：
   - Web Live Room / Chat Room
   - 飞书进度卡片
2. 用户可以在平台统一选择：
   - Agent / Harness
   - Model
   - Reasoning / Thinking 强度
   - Sandbox / Network / Approval 等运行参数

目前最大的问题不是单个 Agent 不工作，而是架构随着 Agent 数量增加越来越难维护。

### 1.1 当前消息链路

现有链路大致为：

```text
Agent CLI stdout / stderr
        ↓
每个 Harness 自己解析 JSON / stream output
        ↓
onStdoutChunk / onToolEvent / onSubagentEvent
        ↓
live-room-progress.ts
  - 文本限流
  - 工具限流
  - 去重
  - heartbeat
        ↓
FeishuProgressTracker / Live Room system message
        ↓
进程结束后再次提取 final output
        ↓
正式 assistant reply
```

这里有一个根本问题：

> `stdout chunk` 被当成了 `Agent semantic message`。

但不同 Agent 的 stdout 含义完全不同。

例如：

```text
Codex           → 相对稳定的 semantic event
Antigravity     → text_delta 碎片
Pi Agent        → 某些事件可能是累计 snapshot
Kimi            → 多种 stream-json / Anthropic delta 兼容格式
普通 CLI        → 甚至可能只是 console output
```

因此不能再让 `onStdoutChunk` 直接进入 UI / 飞书层。

---

# 2. 当前代码中已经存在但尚未真正成为主干的能力

## 2.1 `HarnessStreamCallbacks`

当前：

```ts
interface HarnessStreamCallbacks {
  onStdoutChunk?: ...
  onStderrChunk?: ...
  onToolEvent?: ...
  onSubagentEvent?: ...
  ...
}
```

问题：

`onStdoutChunk` 是 transport-level callback，而不是 semantic-level event。

如果下游把它直接解释成“思考分析”，就会导致：

- delta 被截断
- snapshot 被重复
- 不同 Agent 体验完全不一致
- throttle 会直接造成信息丢失

---

## 2.2 `NormalizedHarnessEvent`

项目已经存在：

```ts
type NormalizedHarnessEvent = {
  kind:
    | 'thinking'
    | 'assistant_text'
    | 'tool_use'
    | 'tool_result'
    | 'system';
  ...
}
```

同时已经实现了一部分：

- sanitize
- sensitive data redact
- preview truncation
- dedupe
- thinking throttle
- tool throttle

这说明方向已经正确，但目前它还不是运行链路的唯一入口。

**建议：不要再新增另一套平行的 Event Model，而是把当前已有 `NormalizedHarnessEvent`、`TaskRunEvent` 等概念合并，最终形成一个平台唯一的 `AgentRunEvent` contract。**

---

# 3. 为什么 Codex 当前体验最好

Codex 当前路径较完整，是因为它有稳定的 app-server / JSON 事件，例如：

- item started
- agent message
- command execution
- patch apply
- MCP tool
- Web Search
- final message

而且公共层当前还专门对 Codex 做文本拼接。

现有代码中类似：

```ts
const isCodex = participant.harnessType === 'codex';
const text = isCodex
  ? (pendingThinkingText += chunk).trim()
  : chunk.trim();
```

这能临时改善 Codex，但从架构角度这是一个明显 warning：

> Presentation 层不应该知道 Agent 是 Codex 还是 Pi。

以后 `live-room-progress.ts` 不应该存在大量：

```ts
if (harnessType === 'codex') ...
```

UI 层应该消费统一的 Presentation State，而不是 Harness-specific 数据。

---

# 4. Antigravity / Pi / Kimi 为什么看起来“不完整”

## 4.1 Antigravity

当前 Antigravity 类似：

```ts
if (typeof step.text_delta === 'string') {
  onStdoutChunk(step.text_delta)
}
```

假设输出：

```text
"I "
"have "
"checked "
"the "
"repository."
```

现在的公共层会：

```text
5 个 delta
   ↓
8 秒 thinking throttle
   ↓
可能只留下其中某一小段
```

这不是 Antigravity 没有输出，而是：

> 系统把“采集频率”和“展示频率”混在了一起。

---

## 4.2 Pi Agent

Pi 的某些 message update 可能是累计文本 snapshot，而不是 delta。

例如：

```text
update 1 = "I"
update 2 = "I have"
update 3 = "I have checked"
```

如果把每个 update 当 delta 拼接，会得到：

```text
II haveI have checked
```

因此统一 Event Model 必须明确区分：

- delta
- snapshot
- completed message

---

# 5. 最核心原则：Ingest 和 Render 必须彻底分开

这是本次重构最重要的一条原则：

> **限流的是 Renderer，不是 Event Stream。**

当前容易形成：

```text
飞书不能频繁 PATCH
      ↓
所以 Agent event 被 throttle / 丢弃
```

正确做法必须是：

```text
Agent raw events
      ↓
100% ingest
      ↓
100% normalize / append
      ↓
100% 保存（至少关键 semantic events）
      ↓
State Projection
      ↓
UI Renderer 每 1~3 秒刷新
```

举例：

Agent 1 秒钟产生：

```text
50 个 text delta
6 个 tool events
```

内部 Event Stream 应全部接受。

但飞书每 1.5 秒只 render 一次当前状态：

```text
🧠 当前分析
我已经检查认证模块，目前发现两个主要问题……

🔧 当前操作
Read src/auth.ts

📊 已执行步骤
17
```

因此平台不会因为飞书的 API rate limit 而丢失 Agent 内容。

---

# 6. 借鉴 Herdr 的核心思想

Herdr 最值得学习的不是某个 API，而是它的抽象边界。

Herdr 的核心思路是：

```text
Claude / Codex / Pi / OpenCode / others
               ↓
          Terminal / PTY
               ↓
             Herdr
               ↓
统一 Pane / Process / IO / Status / Control
```

Herdr 不尝试把每个 Agent 的内部协议变成一样，而是找到一个共同的 runtime 边界：

> 所有 CLI Agent 最终都运行在 process / PTY / terminal 中。

Herdr 因此能够统一：

- agent list
- pane list
- status
- read terminal
- send input
- wait
- split
- lifecycle

对 Agent Platform V2 的启发：

> Agent-specific 差异不可能完全消灭，但应该被压缩到少数 Adapter / Plugin 边界中。

---

# 7. 推荐的最终分层架构

建议最终形成以下 5 层：

```text
┌────────────────────────────────────────────┐
│               Agents / Harnesses           │
│ Codex | Claude | Pi | Kimi | Antigravity  │
└─────────────────────┬──────────────────────┘
                      │
                      ▼
┌────────────────────────────────────────────┐
│ 1. Runtime / Transport                     │
│ process / PTY / SSH / future Herdr         │
│ stdout / stderr / lifecycle / input        │
└─────────────────────┬──────────────────────┘
                      │ Raw Runtime Event
                      ▼
┌────────────────────────────────────────────┐
│ 2. Agent Adapter                           │
│ CodexAdapter                               │
│ ClaudeAdapter                              │
│ PiAdapter                                  │
│ KimiAdapter                                │
│ AntigravityAdapter                         │
│ GenericTerminalAdapter                     │
└─────────────────────┬──────────────────────┘
                      │ AgentRunEvent
                      ▼
┌────────────────────────────────────────────┐
│ 3. Unified Agent Event Stream              │
│ assistant.delta                            │
│ assistant.snapshot                         │
│ assistant.completed                        │
│ tool.started                               │
│ tool.progress                              │
│ tool.completed                             │
│ status.changed                             │
│ subagent.*                                 │
│ system / error / raw                       │
└──────────────┬─────────────────────────────┘
               │
       ┌───────┴──────────┐
       ▼                  ▼
   Event Store      State Projector
                          │
                          ▼
┌────────────────────────────────────────────┐
│ 4. Presentation State                     │
│ status                                     │
│ currentAssistantText                       │
│ currentTool                                │
│ recentTools                                │
│ completedToolCount                         │
│ finalAnswer                                │
│ heartbeat / waiting state                  │
└─────────────────────┬──────────────────────┘
                      │
               ┌──────┴───────┐
               ▼              ▼
┌──────────────────────┐  ┌───────────────────┐
│ 5a. Web Chat / Room  │  │ 5b. Feishu       │
│ SSE / WebSocket      │  │ Card Renderer    │
└──────────────────────┘  └───────────────────┘
```

---

# 8. 推荐的统一 Agent Event Contract

现有 `thinking / assistant_text / tool_use` 不够表达真实 stream 行为。

建议至少区分：

```ts
type AgentRunEvent =
  | AgentStartedEvent
  | AgentStatusEvent
  | AssistantDeltaEvent
  | AssistantSnapshotEvent
  | AssistantCompletedEvent
  | ToolStartedEvent
  | ToolProgressEvent
  | ToolCompletedEvent
  | SubagentStartedEvent
  | SubagentCompletedEvent
  | InteractionRequestEvent
  | ErrorEvent
  | RawRuntimeEvent;
```

## 8.1 Assistant Delta

```ts
interface AssistantDeltaEvent {
  type: 'assistant.delta';
  messageId: string;
  text: string;
}
```

表示：

```text
新增字符 / token / phrase
```

Assembler 应 append。

---

## 8.2 Assistant Snapshot

```ts
interface AssistantSnapshotEvent {
  type: 'assistant.snapshot';
  messageId: string;
  text: string;
}
```

表示：

```text
当前完整文本状态
```

Assembler 应 replace，而不是 append。

---

## 8.3 Assistant Completed

```ts
interface AssistantCompletedEvent {
  type: 'assistant.completed';
  messageId: string;
  text?: string;
}
```

它应该成为：

> 正式 assistant final reply 的权威来源。

以后不要再让 final reply 独立走第二套 extraction 逻辑。

---

# 9. Message Assembler

建议新增一个公共 `MessageAssembler`。

职责：

```text
assistant.delta    → append
assistant.snapshot → replace
assistant.completed → finalize
```

例如 Antigravity：

```text
delta: "I "
delta: "have "
delta: "checked"
```

Assembler：

```text
I have checked
```

Pi snapshot：

```text
snapshot: "I"
snapshot: "I have"
snapshot: "I have checked"
```

Assembler 最终仍为：

```text
I have checked
```

因此文本语义差异被消灭在 Adapter + Assembler 层，而不是下泄到飞书层。

---

# 10. Event Store 与可 Replay 性

建议统一 Event Stream 最终落一个 Event Store。

至少记录：

```text
id
runId
participantId
sequence
sourceHarness
eventType
messageId
timestamp
payload
rawPayload?   // 可选，仅调试或 retention 策略允许时保存
```

例如：

```json
{
  "sequence": 104,
  "sourceHarness": "antigravity",
  "eventType": "assistant.delta",
  "messageId": "assistant-1",
  "payload": {
    "text": "repository."
  }
}
```

这样以后遇到：

> 为什么某次飞书只展示了半句话？

可以 replay 整个事件序列并明确定位：

```text
Capture 问题？
Adapter 问题？
Assembler 问题？
Projection 问题？
Renderer 问题？
Feishu API 问题？
```

而不是再依赖生产日志猜测。

---

# 11. Presentation State：UI 不再认识 Harness

当前 UI / progress 层存在：

```ts
if (harnessType === 'codex') ...
```

未来应取消。

Presentation 层只应该收到：

```ts
interface AgentPresentationState {
  status: 'starting' | 'working' | 'waiting' | 'completed' | 'failed';

  currentAssistantText?: string;

  currentTool?: {
    name: string;
    preview?: string;
    startedAt?: number;
  };

  recentTools: Array<...>;
  completedToolCount: number;
  finalAnswer?: string;
}
```

Web 和飞书统一消费它。

因此：

```text
Codex / Pi / Claude 差异
        ↓
Adapter 层结束
```

Renderer 根本不知道当前是哪种 Agent。

---

# 12. 飞书进度卡片的职责重新定义

飞书卡片应该是：

> 当前 Agent 状态的实时 Projection

而不是：

> Agent 完整 transcript 的数据库

推荐展示：

```text
🤖 Agent: Antigravity
状态：Working

🧠 当前分析
正在检查认证模块的 token refresh 逻辑……

🔧 当前操作
view_file: src/auth.ts

📊 当前进度
累计 21 个工具步骤

最近工具
1. grep_search
2. view_file
3. run_command
4. manage_task
5. view_file
```

完整 Event Transcript 存 Event Store / DB。

Web Chat 可以展示更细粒度的 timeline。

---

# 13. Generic Terminal / Herdr Fallback

新增 Agent 时，不应该再有：

```text
没有专门 parser → 完全无法使用
```

建议提供：

```text
GenericTerminalAdapter
```

最低支持：

```text
process.started
raw.stdout
raw.stderr
process.exited
```

因此新增某个 FooAgent 时：

```text
FooAgent
   ↓
GenericTerminalAdapter
   ↓
平台至少能显示基本运行过程
```

以后如果希望获得更好的：

- assistant message
- tool call
- subagent
- thinking

再写 FooAgent semantic adapter。

这样新增 Agent 从：

```text
“不支持，需要修改平台”
```

变成：

```text
“默认 Basic 支持，写 Adapter 后 Enhanced 支持”
```

---

# 14. Native Events + Terminal Capture 双通道

长期推荐：

```text
Native Agent Protocol
       ↓
Semantic Adapter
         \
          → Unified Event Stream
         /
PTY / Herdr Terminal
       ↓
Raw Transcript
```

两个通道职责：

```text
Native events
→ 高质量结构化事件

Terminal capture
→ ground truth / fallback
```

例如 Codex app-server 协议未来变化导致 parser 失效时，terminal transcript 至少仍存在。

因此 Herdr 可以考虑作为未来统一 runtime / PTY / remote layer，但不要求第一阶段就整体替换现有 child_process / SSH 实现。

---

# 15. 第二个大主题：模型 / Reasoning / 权限配置统一

平台目前已经在 `AcpxParticipantRequest` 中包含：

```ts
model?: string;
reasoningEffort?: string;
```

Codex 当前也已经把这些参数实际传入 CLI / app-server。

问题与消息流类似：

> 不同 Agent 的模型配置方式不同，不能让这些差异散落到 UI 和业务层。

推荐增加：

```text
Agent Capability
+ Model Catalog
+ Run Config
+ Config Adapter
```

---

# 16. 统一 AgentRunConfig

不要让平台上层存 CLI-specific 参数。

例如不要把下面内容存到 DB：

```text
--model xxx
--config model_reasoning_effort="high"
```

平台应保存用户意图：

```ts
interface AgentRunConfig {
  model?: string;

  reasoning?: {
    preset?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    native?: unknown;
  };

  permissions?: {
    sandbox?: 'read-only' | 'workspace-write' | 'full-access';
    network?: boolean;
    approval?: 'never' | 'on-request';
  };
}
```

然后由 Agent Plugin / Config Adapter 翻译。

---

# 17. Capability 描述

每个 Agent 应声明自己支持什么，而不是前端硬编码。

建议：

```ts
interface AgentCapabilities {
  models: {
    configurable: boolean;
    discovery?: 'static' | 'runtime';
  };

  reasoning: {
    supported: boolean;
    presets?: string[];
  };

  sessionResume: boolean;
  liveControl: boolean;
  interactionRequests: boolean;
  subagents: boolean;
  semanticEvents: boolean;
}
```

前端根据 capability 动态显示：

```text
Model selector
Reasoning selector
Sandbox selector
Network toggle
Approval policy
Resume capability
```

而不是给所有 Agent 显示完全一样的字段。

---

# 18. Model Catalog 不应写死在前端

建议统一接口：

```ts
interface AgentModelProvider {
  listModels(): Promise<ModelDescriptor[]>;
}
```

```ts
interface ModelDescriptor {
  id: string;
  label: string;

  capabilities?: {
    reasoning?: boolean;
    vision?: boolean;
    tools?: boolean;
  };

  reasoningPresets?: string[];
}
```

来源可以是：

```text
static manifest
runtime CLI discovery
remote gateway discovery
provider API discovery
```

UI 只请求平台的 Model Catalog。

---

# 19. 不要过度统一 Reasoning

不同 Agent 可能使用：

```text
Codex:
low / medium / high / xhigh

Agent B:
fast / balanced / deep

Agent C:
thinking budget = 16000
```

平台可以提供统一 preset：

```text
Low / Medium / High
```

但不能丢弃 native capability。

因此建议：

```ts
reasoning: {
  preset?: 'low' | 'medium' | 'high';
  native?: Record<string, unknown>;
}
```

普通用户使用 preset。

高级模式可展示 Native Settings。

---

# 20. Agent Profile

建议引入 `Agent Profile`，避免每次任务重新选择全部参数。

例如：

```text
Codex Fast
Codex Deep
Claude Review
Pi Cheap
Antigravity Research
```

Profile 示例：

```json
{
  "name": "Codex Deep",
  "harnessType": "codex",
  "model": "<model-id>",
  "reasoning": {
    "preset": "high"
  },
  "permissions": {
    "sandbox": "workspace-write",
    "network": true,
    "approval": "on-request"
  }
}
```

Live Room 中可以选择：

```text
@Codex Fast
@Codex Deep
@Claude Review
```

这样同一个 harness 可以被配置成多个角色 / 性能层级。

---

# 21. 推荐 Agent Plugin Contract

最终建议把每个 Agent integration 收敛成一个 Plugin。

目录示意：

```text
src/lib/agents/

  core/
    types.ts
    registry.ts
    event-stream.ts
    message-assembler.ts
    projector.ts
    model-catalog.ts

  plugins/
    codex/
      manifest.ts
      capabilities.ts
      models.ts
      config.ts
      runtime.ts
      events.ts

    claude/
      ...

    pi/
      ...

    kimi/
      ...

    antigravity/
      ...

    generic-terminal/
      ...
```

一个 plugin 至少提供：

```ts
interface AgentPlugin {
  manifest: AgentManifest;
  capabilities: AgentCapabilities;

  models?: AgentModelProvider;
  resolveConfig(...): ResolvedRuntimeConfig;
  runtime: AgentRuntime;
  eventAdapter: AgentEventAdapter;
}
```

可以通过 Registry 注册：

```ts
registerAgentPlugin(codexPlugin);
registerAgentPlugin(piPlugin);
```

平台其余部分不需要再写：

```ts
if (harnessType === 'codex')
else if (harnessType === 'pi-agent')
...
```

---

# 22. 新增一个 Agent 的目标开发体验

当前：

```text
新增 Agent
  ↓
executor
parser
callback
Live Room 特殊逻辑
Feishu 特殊逻辑
final extraction
model handling
reasoning handling
remote handling
```

目标：

```text
新增 Agent Plugin
  ↓
manifest
capabilities
runtime
config adapter
event adapter
(optional model discovery)
  ↓
注册
  ↓
结束
```

并且如果只有 runtime：

```text
GenericTerminalAdapter
```

也能提供 Basic Support。

---

# 23. 推荐的渐进迁移路线

**不要一次性推倒重做。**

建议分阶段进行。

## Phase 1 - 定义统一 contract

目标：只设计 contract，不改所有执行器。

完成：

1. 明确 `AgentRunEvent`
2. 明确 delta / snapshot / completed 的区别
3. 明确 Tool lifecycle
4. 明确 Presentation State
5. 明确 Agent Capability / AgentRunConfig

此阶段不要急着迁移全部 Harness。

---

## Phase 2 - MessageAssembler + Projector

实现：

```text
AgentRunEvent
     ↓
MessageAssembler
     ↓
AgentRunProjection
```

新增测试：

```text
Delta 拼接
Snapshot replace
Completed finalize
Tool started / completed
Duplicate events
Out-of-order 防护
```

---

## Phase 3 - 先迁移 Antigravity

原因：

- 当前 text_delta 碎片问题最明显
- 能最直接验证统一 Assembler 是否解决实际体验问题

迁移目标：

```text
step_update.text_delta
        ↓
assistant.delta
```

不再直接：

```text
onStdoutChunk
```

---

## Phase 4 - 迁移 Pi Agent

重点处理：

```text
message_update 是 delta 还是 snapshot
```

本地 Pi 与 remote SSH Pi 必须统一产出相同 `AgentRunEvent`。

远程 transport 差异不能再泄漏到 Presentation 层。

---

## Phase 5 - 迁移 Kimi

把目前多种兼容 parser 输出统一转换到：

```text
assistant.delta / snapshot / completed
tool.started / completed
```

---

## Phase 6 - 最后迁移 Codex

Codex 当前最好用，因此不要第一个改。

迁移后删除：

```text
live-room-progress.ts 中 Codex 特判
```

Codex app-server semantic event 应成为 Agent Event Adapter 的优质输入源。

---

## Phase 7 - 改造 Feishu / Live Room

两者不再直接消费 Harness callback。

改为消费：

```text
AgentRunProjection
```

Feishu 做低频 projection render。

Web Room 可以更实时。

---

## Phase 8 - Agent Plugin / Registry

等消息链路稳定后再正式把：

```text
runtime
config
capabilities
models
events
```

收敛为 Plugin Contract。

---

## Phase 9 - 考虑 Herdr Runtime

Herdr 可以逐步承担：

- PTY hosting
- agent process persistence
- remote workspace
- agent list / status
- terminal transcript fallback
- agent wait / prompt / control

但不要把“接入 Herdr”与“统一消息事件”绑成一次大重构。

建议：

```text
先统一平台内部 Event / Plugin Contract
再将 Herdr 作为一个 Runtime Backend 插入
```

---

# 24. 推荐的 Runtime Backend 抽象

长期可以形成：

```ts
interface AgentRuntimeBackend {
  start(...): Promise<RuntimeHandle>;
  sendInput(...): Promise<void>;
  interrupt(...): Promise<void>;
  stop(...): Promise<void>;
  resume?(...): Promise<RuntimeHandle>;
  subscribeRawEvents(...): AsyncIterable<RawRuntimeEvent>;
}
```

Backend 可以包括：

```text
LocalProcessRuntime
RemoteSshRuntime
HerdrRuntime
GatewayRuntime
```

这样：

```text
Codex / Claude / Pi
```

和：

```text
Local / SSH / Herdr
```

是两个独立维度。

这是非常重要的架构解耦。

---

# 25. Harness 与 Runtime Backend 不要混为一谈

未来数据模型应该区分：

```text
Harness / Agent Type
→ Codex / Claude / Pi / Antigravity

Runtime Backend
→ local / ssh / herdr / gateway
```

例如：

```text
Pi + LocalProcess
Pi + SSH
Pi + Herdr
```

都应该产出完全一样的 `AgentRunEvent`。

当前本地 Pi 与 remote Pi 行为不同，就是因为 transport/backend 差异泄漏到了业务层。

---

# 26. Final Reply 的统一原则

当前：

```text
进度消息一条链
final output 另一条链
```

建议最终：

```text
assistant.delta
assistant.delta
assistant.completed
```

`assistant.completed` 是 final assistant message 的唯一权威来源。

如果某 Harness 只能在进程退出时取得 final result：

Adapter 在退出时生成：

```ts
{
  type: 'assistant.completed',
  text: result
}
```

这样：

- 飞书
- Web Room
- final message
- DB history
- replay

都来源于同一 Event Stream。

---

# 27. 开发时必须避免的反模式

后续 coding agent 在开发时应避免以下模式。

## 27.1 Presentation 层增加 Harness 判断

不要新增：

```ts
if (participant.harnessType === 'xxx')
```

如果必须这样做，优先判断是不是 Adapter 缺少语义。

---

## 27.2 为解决 UI rate limit 丢 Event

禁止：

```text
因为 8 秒只能显示一次
→ 所以只 ingest 8 秒一次
```

应该：

```text
全量 ingest
→ renderer throttling
```

---

## 27.3 每个 Agent 单独维护完整转发逻辑

Agent-specific 逻辑只能集中在：

```text
Plugin / Adapter
```

不要在：

```text
Live Room
Feishu
DB
API Route
UI
```

重复加 Harness 分支。

---

## 27.4 把 stdout 当 assistant message

stdout 只是一种 Transport Signal。

必须先经过 Adapter 才能成为：

```text
assistant.delta
assistant.snapshot
assistant.completed
```

---

## 27.5 先删除 Codex 旧路径再重写

Codex 当前是最稳定路径。

迁移应保持兼容，先增加 Event Pipeline，再切流量。

---

# 28. 建议的测试策略

这次重构一定要以 contract test 为核心。

## Adapter fixtures

每个 Agent 保存真实 output fixture：

```text
tests/fixtures/agents/
  codex/
  pi/
  kimi/
  antigravity/
```

测试：

```text
raw events
   ↓
adapter
   ↓
expected AgentRunEvent[]
```

---

## Message Assembler tests

必须覆盖：

```text
Delta
Snapshot
Completed
重复 delta
重复 snapshot
空文本
中断
restart/resume
```

---

## Replay tests

输入一段已保存 Event Stream：

```text
Event Store
   ↓
Projector replay
   ↓
Presentation State
```

必须得到确定性结果。

---

## Renderer tests

Feishu renderer 不需要知道 Harness。

只输入 Projection fixture。

例如：

```text
working + assistant text + active tool
waiting user
completed
failed
```

---

# 29. 推荐的最终系统概念图

```text
                    ┌──────────────────────┐
                    │      User / Room     │
                    └──────────┬───────────┘
                               │
                      Participant / Profile
                               │
                               ▼
                    ┌──────────────────────┐
                    │    Agent Registry    │
                    └──────────┬───────────┘
                               │
                  ┌────────────┼────────────┐
                  ▼            ▼            ▼
               Codex         Claude         Pi ...
               Plugin        Plugin       Plugin
                  │            │            │
                  └────────────┼────────────┘
                               │
                        Resolved Run Config
                               │
                               ▼
                    ┌──────────────────────┐
                    │   Runtime Backend    │
                    │ local / SSH / Herdr │
                    └──────────┬───────────┘
                               │ Raw Runtime Events
                               ▼
                    ┌──────────────────────┐
                    │    Event Adapter     │
                    └──────────┬───────────┘
                               │ AgentRunEvent
                               ▼
                    ┌──────────────────────┐
                    │ Unified Event Stream │
                    └──────────┬───────────┘
                               │
                    ┌──────────┴───────────┐
                    ▼                      ▼
                Event Store          State Projector
                                           │
                                           ▼
                                   Presentation State
                                           │
                              ┌────────────┴───────────┐
                              ▼                        ▼
                         Web Chat                  Feishu
```

---

# 30. 本次架构重构的真正目标

不要把目标定义为：

> “把 Antigravity 飞书输出修好。”

也不要定义为：

> “支持下一个新 Agent。”

真正目标应该是：

> **让未来新增一个 Agent 时，只需实现一个 Plugin / Adapter；让任何 Agent 的输出、模型、reasoning、权限和 runtime 差异，都不再污染平台核心、Web Room 和 Feishu。**

具体衡量标准：

```text
新增 Agent
→ 不修改 live-room-progress
→ 不修改 Feishu renderer
→ 不修改 Web renderer
→ 不增加公共层 harnessType 判断
→ 不复制 final response extraction 流程
→ 只增加 Plugin / Adapter / Capability / Runtime binding
```

如果达到这一点，说明这次重构成功。

---

# 31. Coding Agent 开发指令建议

后续 coding agent 接手时，请遵守：

1. **先阅读仓库 `AGENTS.md`、workflow contract、当前 PLAN / HANDOVER。**
2. 先梳理真实运行链路，不要根据本文直接猜文件修改方案。
3. 本文是架构目标，不是要求一次性完成全部重构。
4. 优先建立 contract 和测试，再迁移 Harness。
5. 保持 Codex 当前稳定能力，不应先破坏后重写。
6. 优先消除 Presentation 层的 Harness-specific 判断。
7. Runtime Backend 与 Agent/Harness 类型必须解耦。
8. Event ingest 必须完整，throttle 只能发生在展示层。
9. Final assistant reply 最终应来自统一 Event Stream。
10. 新 Agent 必须至少支持 Generic Terminal fallback。
11. 所有 Agent-specific parsing/config 逻辑集中在 Plugin / Adapter 边界。
12. 每阶段完成后用真实 CLI fixture 做回归，而不仅是 mock。

---

# 32. 推荐第一张 PLAN 的范围

建议第一轮开发不要做 Herdr 接入，也不要直接 Plugin 化全部 Agent。

第一张 PLAN 建议只包含：

```text
目标：建立 Unified Agent Event Backbone
```

Scope：

1. 定义 `AgentRunEvent` contract
2. 明确 delta / snapshot / completed
3. 实现 `MessageAssembler`
4. 实现基础 `AgentRunProjector`
5. 建立 replay / fixture tests
6. 选择 Antigravity 作为第一个迁移 Harness
7. 保持现有 Feishu / Live Room 路径兼容

Explicitly Out of Scope：

```text
Herdr runtime migration
全部 Harness 一次性迁移
Model Catalog 完整 UI
Agent Profile UI
删除旧 callback API
Codex 大规模改写
```

等第一阶段稳定后，再进入：

```text
Pi → Kimi → Codex → Renderer → Plugin Registry → Herdr Runtime
```

---

## 最后一句架构原则

> **平台应该理解“Agent Event”，而不应该理解每一个 Agent 的 stdout。**
>
> **平台应该表达“用户想用什么能力”，而不是在业务层拼每一个 Agent 的 CLI 参数。**
>
> **Agent-specific 差异应该存在，但只能存在于 Plugin / Adapter 边界。**

