# 39 Windows 平台 Claude 修复与下一步计划

## 日期
2026-03-26

## 本文目的

记录 Windows 平台迁移中发现的问题、修复方案，以及对 Live Room @提及 机制和 ACPX 功能实现状态的分析。

---

## 第一部分：Windows 平台 Claude CLI 调用失败问题

### 问题描述

在 Windows 服务器上运行 "Platform Local Claude" agent 时，出现以下错误：

```
Error: spawn claude ENOENT
```

### 根本原因

Node.js 的 `spawn()` 函数在 Windows 上处理 `.cmd` 文件的方式与 Unix 不同：

1. **Unix/Linux**: `spawn('claude', ...)` 可以直接找到 PATH 中的可执行文件
2. **Windows**: `spawn('claude', ...)` with `shell: false` 无法找到 `.cmd` 文件（如 `claude.cmd`）

Claude CLI 在 Windows 上安装为 `C:\Users\Administrator\AppData\Roaming\npm\claude.cmd`，但默认的 spawn 配置无法定位它。

### 修复方案

修改文件：`src/lib/real-agents/claude-agent.ts`

**修改点 1**: executeClaudeCLI 中的 spawn 调用（第 192 行）

```javascript
// 修改前
const child = spawn('claude', args, {
  cwd: options.workingDirectory,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});

// 修改后
const shell = process.platform === 'win32';
const child = spawn('claude', args, {
  cwd: options.workingDirectory,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell,  // Windows 上为 true，Unix 上为 false
});
```

**修改点 2-4**: isClaudeAvailable、getClaudeVersion、initClaudeConfig 中的 exec 调用

所有 `execAsync()` 调用都添加了 `shell: true` 选项，确保在 Windows 上能找到 `.cmd` 文件。

### 兼容性影响

- **Linux/Unix**: `shell: false` - 保持原有行为，安全高效
- **Windows**: `shell: true` - 能够找到 `.cmd` 文件

该修复对 Linux 功能无影响。

---

## 第二部分：Live Room @提及 机制问题分析

### 用户报告的问题

```
你: @Platform Local Claude this is a test, I mentioned you,
    so you should reply to me, but the other agent in this room should not

Platform Local Claude: I see you've typed "@Platform" -
    could you clarify what you'd like me to help with?

main (Linux Gateway): No response from OpenClaw.

Platform Local Claude: I'm not sure what you're trying to communicate
    with "@Platform" and "No".
```

**预期行为**: 只有被 @提及的 "Platform Local Claude" 应该回复
**实际行为**: 多个 agent 都回复了，且 Claude 没有正确识别完整的名称

### 问题分析

#### 1. 提及检测逻辑

位置：`src/lib/live-room.ts` 第 816-872 行

```javascript
export const detectMentionedLiveRoomMembers = ({
  content,
  members,
  senderMemberId,
}: {
  content: string;
  members: LiveRoomMentionableMember[];
  senderMemberId?: string | null;
}) => {
  // ...
  for (const member of members) {
    const aliases = [
      member.displayName,                    // "Platform Local Claude"
      member.runtimeAgentId || '',           // "claude"
      `${member.displayName} · ${member.gateway.name} / ${member.harnessType}`,
      // ...
    ];

    const explicitMentionIndex = findEarliestExplicitMentionIndex(content, aliases);
    // ...
  }
};
```

#### 2. 潜在问题点

| 问题 | 位置 | 影响 |
|------|------|------|
| **短名称优先匹配** | `findEarliestExplicitMentionIndex` 按索引排序，短匹配可能先返回 | "@Platform" 可能匹配到 "Platform Local Claude" |
| **Broadcast 回退逻辑** | 当没有明确提及目标时，默认 broadcast | 所有 agent 都可能响应 |
| **Agent 回复中的提及检测** | Agent 的回复内容也会被检测提及 | 可能触发连锁反应 |

#### 3. 具体问题

在 `src/lib/live-room-delivery.ts` 第 627-653 行：

```javascript
const replyMessage = await postLiveRoomMessage({
  // ...
  metadata: resolveLiveRoomMessageMetadata({
    senderKind: 'assistant',
    replyToMessageId: sourceMessage.id,
    mentionedMemberIds: detectMentionedLiveRoomMembers({
      content: output,  // Agent 的回复内容
      members: room.members,
      senderMemberId: targetMember.id,
    }),
    // ...
  }),
});
```

这意味着：
1. 用户 @Platform Local Claude
2. Claude 回复
3. Claude 的回复被再次检测提及
4. 如果 Claude 的回复中包含其他 agent 的名称模式，可能触发连锁反应

### 改进建议

#### 优先级 1: 修复提及匹配优先级

```javascript
// 当前：按出现位置排序
return resolvedMatches.sort((left, right) => left.index - right.index);

// 建议：优先选择最长匹配
return resolvedMatches
  .sort((left, right) => {
    if (left.index !== right.index) return left.index - right.index;
    return right.aliasLength - left.aliasLength;  // 同位置优先长匹配
  });
```

#### 优先级 2: 区分用户消息和 Agent 消息的提及语义

- 用户消息的 @提及 = 明确的调用意图
- Agent 消息的提及 = 可能是引用，不应该触发新回复

#### 优先级 3: 添加调试日志

```javascript
console.log('[Mention Detection]', {
  content,
  detectedMentionedMemberIds,
  deliveryIntent,
});
```

---

## 第三部分：ACPX Live Room 功能实现状态

### 对照 `38_ACPX_LIVE_ROOM_PLAN_C_BRIDGE_FOUNDATION_HANDOVER.md`

#### 已完成的功能 ✅

| 功能 | 状态 | 关键文件 |
|------|------|----------|
| Live Room 自动拥有 backing ACPX task | ✅ | `live-room.ts:syncLiveRoomSourceTask` |
| Live Room member 稳定 ACPX participant identity | ✅ | `live-room.ts:getLiveRoomParticipantContinuationKey` |
| Live Room message 镜像到 task room | ✅ | `live-room.ts:postLiveRoomMessage` |
| Live Room reply 执行走 ACPX single-participant run | ✅ | `live-room-delivery.ts:executeLiveRoomReplyViaAcpx` |
| Interrupt 优先对接 ACPX active participant | ✅ | `live-room-delivery.ts:interruptLiveRoomMemberReplies` |
| Generic ACPX continuation (local Claude) | ✅ | `claude-agent.ts` + `acpx/session-tracking.ts` |
| Generic ACPX continuation (remote SSH) | ✅ | `ssh-executor.ts` |
| ACPX control UI 不再只假设 local Codex | ✅ | `task control route` + `task chat page` |

#### 部分完成的功能 ⚠️

| 功能 | 状态 | 说明 |
|------|------|------|
| Remote SSH native session resume | ⚠️ | 可 resume 同一 session，但每轮新起进程 |
| Local Claude 真实 continuation | ✅ | 使用 `--resume <session_id>` |
| Gateway OpenClaw continuation | ❌ | 未在 continuation 范围内 |

#### 未完成的功能 ❌

| 功能 | 状态 | 说明 |
|------|------|------|
| Live Room UI 直接消费 ACPX event stream | ❌ | UI 仍主要看 live-room 自己的 pending/reply 状态 |
| Remote live session control (long-lived transport) | ❌ | 仍是 process control，非 daemon 模式 |
| Gateway OpenClaw continuation | ❌ | 未纳入 continuation 语义 |

---

## 第四部分：Live Chat vs Task Run 的区别

### 当前架构中的两种模式

#### 模式 A: Live Room Chat

**特点**:
- 实时对话模式
- 用户发送消息后，被提及的 agent 立即响应
- 每条消息触发一次独立的 ACPX single-participant run
- 支持多 agent 在同一房间，通过 @提及 切换

**执行流程**:
```
用户消息 → Live Room
    ↓
检测 @提及目标
    ↓
triggerLiveRoomAgentReply (单 agent)
    ↓
executeLiveRoomReplyViaAcpx (single-participant ACPX run)
    ↓
Agent 回复 → Live Room
```

**关键代码路径**:
- `api/live-rooms/[id]/messages/route.ts` → POST
- `live-room-delivery.ts:triggerLiveRoomAgentReply`
- `live-room-delivery.ts:executeLiveRoomReplyViaAcpx`

#### 模式 B: Task Run

**特点**:
- 长期任务执行模式
- 支持多种编排模式 (single, all, round_robin)
- 可独立于 Live Room 运行
- 有明确的 task 开始/结束状态

**执行流程**:
```
创建 Task → 定义 participants + orchestrationMode
    ↓
executeAcpxTaskRun
    ↓
根据 orchestrationMode 执行:
  - single: 指定单个 participant 执行
  - all: 所有 participant 顺序执行
  - round_robin: participant 轮流执行
    ↓
Task 完成 → 更新 task 状态
```

**关键代码路径**:
- `api/tasks/route.ts` → POST (创建 task)
- `acpx/runner.ts:executeAcpxTaskRun`

### 两者对比

| 维度 | Live Room Chat | Task Run |
|------|----------------|----------|
| **触发方式** | 用户发送消息 | 创建/启动 Task |
| **执行时长** | 短（单次回复） | 长（可能多轮） |
| **编排模式** | 仅 single (single-participant) | single / all / round_robin |
| **状态追踪** | live-room message + delivery | task + taskSession + taskRun |
| **Continuation** | 支持 (通过 ACPX session) | 支持 (通过 ACPX session) |
| **多 Agent 协作** | 通过 @提及 和 chained mentions | 通过 orchestrationMode |

---

## 第五部分：多 Agent 协作工作流设计

### 用户需求分析

> "如果我想实现多个 agent 之间的协作，比如先讨论一个主题，然后决定任务分配，再像工作流一样执行任务，可能需要同时使用 chat 和 task run 吗？"

### 建议的协作工作流

#### 阶段 1: 讨论阶段 (Live Room Chat)

```
Live Room: "项目规划"
Members: Product Manager Claude, Developer Codex, Reviewer Claude

用户: @Product Manager Claude 我们需要设计一个新功能

Product Manager Claude: [分析需求，提出方案]

用户: @Developer Claude 你觉得这个方案可行吗？

Developer Claude: [技术评估，提出修改意见]

用户: @all 大家同意这个方案吗？

[所有 agent 依次回应]
```

**使用 Live Room 的原因**:
- 需要多轮对话
- 需要 @提及 精确控制谁发言
- 需要即时反馈

#### 阶段 2: 任务执行阶段 (Task Run)

```
创建 Task: "实现新功能 X"
orchestrationMode: "round_robin"
participants: [Developer Codex, Reviewer Claude, Tester Claude]

执行流程:
1. Developer Codex 编写代码
2. Reviewer Claude 审查代码
3. Tester Claude 编写/运行测试
4. 完成后返回结果
```

**使用 Task Run 的原因**:
- 有明确的执行顺序
- 需要完整的任务状态追踪
- 可能需要长时间执行

### 架构改进建议

#### 改进 1: Live Room → Task Run 的桥接

在 Live Room 中添加 "创建 Task" 的系统命令：

```
用户: /create-task "实现新功能 X" --mode round_robin --participants Developer Codex,Reviewer Claude

系统: 已创建 Task "实现新功能 X" (ID: task_abc)
     点击查看: /tasks/task_abc
```

#### 改进 2: Task Run → Live Room 的结果回传

Task 完成后，自动在 Live Room 中发送摘要消息：

```
[系统] Task "实现新功能 X" 已完成
摘要: Developer Codex 完成了代码实现，Reviewer Claude 审查通过...
详情: /tasks/task_abc
```

#### 改进 3: 混合模式 - "讨论 + 执行"

在 Live Room 中添加一种新的消息类型 `task_proposal`：

```
用户: @Developer Claude 请帮我实现这个功能，完成后在群里通知大家

[系统] 已创建 background task，执行中...
[稍后...]
Developer Claude: 功能已实现完成，代码已提交到 feature/new-feature-x 分支
Reviewer Claude: 我来审查一下代码
[审查过程...]
Reviewer Claude: 审查通过，可以合并
```

---

## 第六部分：下一步行动计划

### 紧急问题修复 (优先级 P0)

1. **修复 @提及 匹配逻辑**
   - 文件: `src/lib/live-room.ts`
   - 问题: 短名称优先于长名称匹配
   - 修复: 按匹配长度排序，优先选择最长匹配

2. **防止 Agent 回复触发连锁反应**
   - 文件: `src/lib/live-room-delivery.ts`
   - 问题: Agent 回复内容被检测提及，可能触发其他 agent
   - 修复: 区分用户消息和 Agent 消息的提及语义

### 功能增强 (优先级 P1)

3. **Live Room @提及调试功能**
   - 添加 `resolveLiveRoomMessageMetadata` 的详细日志
   - 在 UI 中显示当前消息的 `deliveryIntent` 和 `expectedResponderMemberIds`

4. **Live Room → Task Run 桥接**
   - 在 Live Room 中添加 `/create-task` 系统命令
   - Task 完成后自动回传结果到 Live Room

### 架构完善 (优先级 P2)

5. **Live Room UI 消费 ACPX event stream**
   - 当前: UI 依赖 live-room 自己的 pending/reply 状态
   - 目标: UI 直接订阅 ACPX participant/run events

6. **Remote live session control 改进**
   - 当前: 每轮新起进程
   - 目标: 长期常驻的 remote agent transport/daemon

---

## 第七部分：相关文件清单

### 本次修复涉及的文件

| 文件 | 修改内容 |
|------|----------|
| `src/lib/real-agents/claude-agent.ts` | Windows spawn 兼容性修复 |
| `package.json` | 添加 `-H 0.0.0.0 -p 3010` 启动参数 |
| `.env` | 端口配置更新 |

### @提及 机制相关文件

| 文件 | 作用 |
|------|------|
| `src/lib/live-room.ts` | 提及检测逻辑 (`detectMentionedLiveRoomMembers`) |
| `src/lib/live-room-delivery.ts` | 消息投递和连锁提及处理 |
| `src/app/api/live-rooms/[id]/messages/route.ts` | 消息 API 入口 |

### ACPX 相关文件

| 文件 | 作用 |
|------|------|
| `src/lib/acpx/runner.ts` | ACPX 任务执行 |
| `src/lib/acpx/session-tracking.ts` | Session 追踪 |
| `src/lib/acpx/catalog.ts` | Agent 目录 |

---

## 一句话总结

本次修复解决了 Windows 平台 Claude CLI 调用问题，同时分析了 Live Room @提及 机制的潜在问题和 ACPX 功能实现状态。下一步应优先修复 @提及匹配逻辑，并增强 Live Room 与 Task Run 之间的协作能力。
