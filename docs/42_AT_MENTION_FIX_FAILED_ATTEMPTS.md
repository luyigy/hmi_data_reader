# 42 @提及 修复失败尝试记录

## 日期
2026-03-26

## 问题描述

用户在 Live Room 中发送 `@Platform Local Claude 你好`，但：
1. **提及检测正确** - 日志显示正确匹配了 "Platform Local Claude"
2. **但 agent 收到的消息仍包含 @提及** - Claude CLI 把 `@Platform` 当作命令解析
3. **无关上下文被包含** - Feishu 测试等内容出现在 prompt 中

### 用户看到的输出

```
你: @Platform Local Claude what are you taking about, just introduce yourself to me in chinese

Platform Local Claude: I see you've mentioned "@Platform" - could you clarify what you'd like to do?
```

### 调试日志显示

```
[Mention Detection] ✓ Explicit match for Platform Local Claude: { index: 0, matchedAlias: 'Platform Local Claude', matchedLength: 21 }
[Claude] Prompt: @Platform Local Claude what are you taking about...
```

- 提及检测：✅ 正确
- 但传给 Claude 的 prompt 仍包含 `@Platform Local Claude`

---

## 根本原因分析

### 问题 1: Claude CLI 把 @xxx 当作命令

Claude CLI 有自己的命令解析逻辑：
- `/update-config` - 配置设置
- `/keybindings-help` - 键盘快捷键
- `@xxx` - 被 Claude CLI 解释为 skill/command 调用

当收到 `@Platform Local Claude hello` 时：
- Claude CLI 尝试查找名为 "Platform" 的 skill
- 找不到则返回错误消息

### 问题 2: Task Room 累积历史消息

Task room 保存所有历史消息，agent 收到的 prompt 包含：
- Task name
- Task description
- Latest task-room instruction ← 当前消息
- Recent task-room transcript ← 历史消息（包含 Feishu 测试等）
- Previous participant outputs

---

## 已尝试的修复

### 尝试 1: 改进提及匹配优先级 ✅ 成功

**文件**: `src/lib/live-room.ts`

**修改内容**:
- 新增 `MentionMatchResult` 接口
- `findBestExplicitMentionMatch` 和 `findBestPlainMentionMatch`
- 优先选择最长匹配（位置相同时）

**结果**: 提及检测现在可以正确匹配 "Platform Local Claude" 而不是只匹配 "Platform"

---

### 尝试 2: 防止 Agent 回复触发连锁 ✅ 成功

**文件**: `src/lib/live-room.ts` + `src/lib/live-room-delivery.ts`

**修改内容**:
- Agent 消息的 @提及 默认设为 `broadcast`（不触发自动回复）
- 只有 `handoff` 或 `ask` 模式才触发连锁回复

**结果**: Agent 之间的无意连锁回复被阻止

---

### 尝试 3: 去掉消息开头的 @提及 ❌ 失败

**目标**: 传给 agent 之前，去掉 `@Platform Local Claude` 部分

**修改的文件**:

1. **`src/lib/live-room.ts`** (第 864-881 行)
```typescript
// 对于用户消息，总是尝试去掉开头的 @提及
if (created.senderMember?.memberType === 'user') {
  const mentionMatch = created.content.match(/^@[\S\s]+?\s+(.*)$/s);
  if (mentionMatch) {
    contentForTaskRoom = mentionMatch[1].trim();
  }
}
```

2. **`src/lib/live-room-delivery.ts`** (第 240-259 行)
```typescript
const stripMention = (content: string) => {
  const match = content.match(/^@[\S\s]+?\s+(.*)$/s);
  return match ? match[1].trim() : content;
};
const contentForAgent = stripMention(sourceMessage.content);
```

**预期行为**: `@Platform Local Claude 你好` → `你好`

**实际结果**: 失败，agent 仍收到包含 @提及 的消息

**可能原因**:
1. 代码没有重新编译/缓存问题
2. 修改的位置不对（task room message 和 agent prompt 是两条路径）
3. 时序问题：agent 执行时读取的是旧的 task room 内容

---

## 消息流程分析

### 当前流程

```
1. 用户发送 "@Platform Local Claude 你好" 到 Live Room
   ↓
2. POST /api/live-rooms/[id]/messages
   ↓
3. detectMentionedLiveRoomMembers → 正确检测到 Platform Local Claude
   ↓
4. postLiveRoomMessage
   - 保存到 Live Room (完整内容)
   - 镜像到 Task Room (应该去掉 @提及) ← 修复点 1
   ↓
5. triggerLiveRoomAgentReply
   ↓
6. executeLiveRoomReplyViaAcpx
   - 获取 latestSession
   - 调用 executeAcpxTaskRun
   ↓
7. buildAcpxParticipantHarnessPrompt (ACPX runner)
   - buildTaskRoomPromptContext
   - 获取 latestUserMessage ← 应该是去掉 @提及的
   ↓
8. Claude CLI 收到 prompt
   - 包含 "@Platform Local Claude" ← 问题在这里
```

### 问题定位

日志显示 `[Claude] Prompt: @Platform Local Claude...`，说明：

1. 要么 task room 里的消息没有被正确去掉 @提及
2. 要么 agent 执行时读取的不是最新的 task room 消息
3. 要么有其他路径在传递原始内容

**需要检查**:
- Task room 实际存储的内容
- `buildTaskRoomPromptContext` 获取的 `latestUserMessage`
- 是否有缓存或时序问题

---

## 相关代码位置

### 提及检测
- `src/lib/live-room.ts:205-350` - 匹配函数
- `src/lib/live-room.ts:896-983` - `detectMentionedLiveRoomMembers`

### 消息镜像到 Task Room
- `src/lib/live-room.ts:863-901` - `postLiveRoomMessage` 中的 task room 镜像逻辑

### Agent 执行
- `src/lib/live-room-delivery.ts:186-335` - `executeLiveRoomReplyViaAcpx`
- `src/lib/acpx/runner.ts:96-145` - `buildAcpxParticipantHarnessPrompt`
- `src/lib/task-room.ts:96-135` - `buildTaskRoomPromptContext`

### Claude CLI 调用
- `src/lib/real-agents/claude-agent.ts:135-300` - `executeClaudeCLI`

---

## 下一步建议

### 优先级 1: 调试验证

**需要确认**:
1. Task room 中存储的消息是否真的去掉了 @提及
2. `buildTaskRoomPromptContext` 返回的 `latestUserMessage.content` 是什么

**添加调试日志**:
```typescript
// 在 postTaskRoomMessage 之后
console.log('[Task Room] Posted:', { content: contentForTaskRoom });

// 在 buildTaskRoomPromptContext 中
console.log('[Task Room Context] Latest message:', latestUserMessage);
```

### 优先级 2: 修复方案

**方案 A: 确保消息正确镜像**
- 验证 `postLiveRoomMessage` 中的 stripping 逻辑生效
- 确认没有其他地方在覆盖 stripped content

**方案 B: 在 ACPX runner 中再次 stripping**
- 在 `buildTaskRoomPromptContext` 中，对 `latestUserMessage.content` 再次去掉 @提及
- 作为双重保险

**方案 C: 直接在 Claude CLI 调用处 stripping**
- 在 `claude-agent.ts` 的 `executeClaudeCLI` 中
- 对 `prompt` 进行后处理，去掉开头的 `@xxx` 模式

### 优先级 3: 清理 Task Room 历史消息

**问题**: Task room 累积所有历史消息，导致 prompt 包含无关上下文

**临时方案**:
- 添加 API 端点清空 task room 消息
- 或者在 Live Room 创建时重置 task room

**长期方案**:
- 只传递当前消息，不传递完整 transcript
- 或限制 transcript 的长度/时间范围

---

## 已完成的修复（可用）

### ✅ P0-1: 提及匹配优先级
- 长名称优先于短名称
- 位置相同时按长度降序排序

### ✅ P0-2: 防止连锁回复
- Agent 消息不触发自动回复（除非 handoff/ask）
- 更新了 `resolveLiveRoomMessageMetadata` 逻辑

### ✅ P0-3: Windows Claude CLI 兼容
- `shell: process.platform === 'win32'`
- Linux 不受影响

---

## 测试命令

### 启用调试日志
```bash
# .env
DEBUG_MENTION_DETECTION=true
```

### 测试用例
```
@Platform Local Claude 你好
@Platform Local Claude introduce yourself in chinese
@main hello
```

### 预期行为
- 只有被 @提及的 agent 回复
- Agent 收到的消息不包含 @提及 部分
- 无关历史消息不被包含

---

## 文件清单

### 本次修改的文件
1. `src/lib/live-room.ts` - 提及检测、消息镜像
2. `src/lib/live-room-delivery.ts` - Agent 执行、连锁回复
3. `src/lib/real-agents/claude-agent.ts` - Windows 兼容
4. `.env` - 添加 DEBUG_MENTION_DETECTION

### 需要继续检查的文件
1. `src/lib/task-room.ts` - Task room 消息获取
2. `src/lib/acpx/runner.ts` - Prompt 构建
3. `src/app/api/live-rooms/[id]/messages/route.ts` - 消息 API 入口

---

## 一句话总结

@提及检测逻辑已修复，但消息传递给 agent 的路径仍有问题，需要进一步调试 task room 消息存储和 ACPX prompt 构建流程。
