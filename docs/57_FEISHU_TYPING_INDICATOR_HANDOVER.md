# 57 飞书"正在输入"Typing 表情指示器交接文档

## 日期
2026-04-04

---

## 一、功能概述

在飞书消息上添加 ⌨️（Typing）表情回应，作为"正在输入"视觉反馈：

- 收到消息 → 立即在消息上添加 Typing 表情
- Agent 回复完成（或出错）→ 删除表情

使用的飞书 API：消息表情回应（Message Reaction）

---

## 二、本次已完成的改动

### `src/lib/feishu-api.ts`

新增两个函数：

```typescript
// 添加 Typing 表情，返回 reactionId（失败静默返回 null）
addTypingReaction(messageId: string): Promise<string | null>

// 删除表情（失败静默处理）
removeTypingReaction(messageId: string, reactionId: string): Promise<void>
```

两个函数均静默失败，不影响正常消息流程。

### `src/lib/feishu-long-connection.ts`

在 `/ap` 命令处理路径加了 typing 指示器：

```
收到 /ap 命令 → addTypingReaction
  → handleFeishuCommand（处理中）
  → removeTypingReaction（成功或失败均执行）
  → sendFeishuTextMessage
```

---

## 三、待完成：普通消息（live room relay）路径

### 问题

普通消息（非 `/ap` 命令）走 `tryRelayNonCommandToLiveRoom`，该函数是异步分发的：
- 函数返回时 agent 才刚开始处理
- typing 的"开始"在消息入队时，"结束"在 agent 回复发出时

两端跨越不同模块，不能简单夹在 relay 函数前后。

### 实现方案（下一步）

**开始端**（`feishu-long-connection.ts`）：
- 在 `tryRelayNonCommandToLiveRoom` 调用前，`addTypingReaction` 并把 `reactionId` 传入 relay 上下文

**结束端**（`src/lib/feishu-live-room-relay.ts` 或 `live-room-delivery.ts`）：
- agent 回复通过 `postLiveRoomMessage` / relay 发出后，调用 `removeTypingReaction`
- 需要把 `messageId` + `reactionId` 随 relay 上下文一起传递下去

### 需要改动的文件

| 文件 | 改动 |
|------|------|
| `src/lib/feishu-long-connection.ts` | relay 前调用 `addTypingReaction`，将 reactionId 写入 relay context |
| `src/lib/feishu-live-room.ts` | `tryRelayNonCommandToLiveRoom` 接收并传递 typing context |
| `src/lib/feishu-live-room-relay.ts` | 回传飞书消息后调用 `removeTypingReaction` |

---

## 四、文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/lib/feishu-api.ts` | 修改 | 新增 addTypingReaction / removeTypingReaction |
| `src/lib/feishu-long-connection.ts` | 修改 | /ap 命令路径加 typing 指示器 |
| `docs/57_FEISHU_TYPING_INDICATOR_HANDOVER.md` | 新增 | 本文档 |
