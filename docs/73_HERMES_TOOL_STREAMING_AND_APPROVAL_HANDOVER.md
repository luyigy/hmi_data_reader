# 73 — Hermes 学习：实时工具流 & 飞书审批卡片

**日期**：2026-04-18  
**目标**：参考 Hermes 实现，为我们的平台补上两个缺失功能：
1. Agent 执行过程中实时向飞书发工具进度（🔎/💻/🐍 等）
2. Agent 请求危险操作权限时，飞书弹审批卡片，用户点按钮批准/拒绝

---

## 一、功能 1：实时工具进度流

### Hermes 的做法

**核心模式：单条消息 + 持续 edit**

1. Agent 每触发一个工具，调用 `progress_callback(event_type="tool.started", tool_name=..., preview=...)`
2. callback 把格式化后的行（如 `🔎 search_files: "FEISHU_APP_ID..."` ）放入 `progress_queue`
3. 后台异步任务 `send_progress_messages()` 消费队列：
   - 首次有内容时发一条新消息，拿到 `progress_msg_id`
   - 后续累积行，每 **1.5 秒** edit 一次该消息（节流）
   - 重复行合并为 `(×N)` 后缀，避免刷屏
4. Agent 完成后做最终 flush

**Emoji 映射表**（来自各工具注册时声明）：

| 工具类型 | Emoji |
|---------|-------|
| terminal / shell | 💻 |
| search_files | 🔎 |
| execute_code (Python) | 🐍 |
| read_file | 📖 |
| write_file | ✍️ |
| patch / edit | 🔧 |
| web navigate | 🌐 |
| skill_view | 📚 |

**关键源码位置**（Hermes）：
- `gateway/run.py:8594` — `progress_callback()` 格式化工具事件
- `gateway/run.py:8673` — `send_progress_messages()` 节流 + edit
- `agent/display.py:135` — `get_tool_emoji()` 查 emoji
- `gateway/platforms/feishu.py:1421` — `edit_message()` 调飞书 edit API

### 我们平台的现状

- `claude-agent.ts` 的 `onStdoutChunk` 流式输出只发原始文本，没有工具事件拦截
- `live-room-delivery.ts` 的 `normalizeProgressPreview()` 有一个简单的进度预览，但只在每次 reply 结束后发一条，不是实时的
- 飞书侧完全没有进度消息机制

### 实现方案

#### Step 1：从 Claude/Codex stdout 解析工具事件

Claude CLI 以 `--output-format stream-json` 输出，每行一个 JSON 事件。其中工具调用事件格式：
```json
{"type": "tool_use", "name": "Bash", "input": {"command": "ls -la"}}
{"type": "tool_result", "tool_use_id": "...", "content": "..."}
```

在 `claude-agent.ts` 的 stdout 解析循环里（当前 ~line 288），增加对 `event.type === 'tool_use'` 的处理，提取 `name` 和 `input` 并调用新的 `onToolEvent` 回调。

#### Step 2：定义 onToolEvent 回调链

在 `HarnessStreamCallbacks`（`src/lib/acpx/types.ts`）增加：
```typescript
onToolEvent?: (event: { toolName: string; preview: string; emoji: string }) => Promise<void>;
```

工具 → emoji 映射表（新建 `src/lib/acpx/tool-emojis.ts`）：
```typescript
const TOOL_EMOJI_MAP: Record<string, string> = {
  Bash: '💻',
  Read: '📖',
  Write: '✍️',
  Edit: '🔧',
  Grep: '🔎',
  Glob: '🔎',
  WebSearch: '🌐',
  WebFetch: '🌐',
  Task: '🤖',
};
const DEFAULT_EMOJI = '⚙️';
```

#### Step 3：飞书侧进度消息

在 `src/lib/feishu-live-room-relay.ts`（或新建 `feishu-progress.ts`）实现：

```typescript
class FeishuProgressTracker {
  private progressMsgId: string | null = null;
  private lines: string[] = [];
  private lastEditAt = 0;
  private readonly THROTTLE_MS = 1500;

  async onToolEvent(chatId: string, toolName: string, preview: string, emoji: string) {
    const line = `${emoji} ${toolName}: "${preview.slice(0, 40)}${preview.length > 40 ? '...' : ''}"`;
    
    // 合并重复行
    if (this.lines.at(-1)?.startsWith(`${emoji} ${toolName}:`)) {
      // 追加 (×N)
    } else {
      this.lines.push(line);
    }
    
    const now = Date.now();
    if (!this.progressMsgId) {
      // 首次：发新消息
      this.progressMsgId = await sendFeishuTextMessage(chatId, this.lines.join('\n'));
    } else if (now - this.lastEditAt > this.THROTTLE_MS) {
      // 节流 edit
      await editFeishuMessage(this.progressMsgId, this.lines.join('\n'));
      this.lastEditAt = now;
    }
  }

  async flush(chatId: string) {
    if (this.progressMsgId && this.lines.length > 0) {
      await editFeishuMessage(this.progressMsgId, this.lines.join('\n'));
    }
  }
}
```

飞书 edit message API：`PATCH /im/v1/messages/{message_id}` — 需要在 `feishu-api.ts` 新增 `editFeishuMessage(messageId, content)` 函数。

#### Step 4：接入 triggerLiveRoomMessageReplies

在 `live-room-delivery.ts` 的 `executeAcpxTaskRun` 调用处，把 `FeishuProgressTracker` 实例作为 `streamCallbacks.onToolEvent` 传入。

---

## 二、功能 2：飞书审批卡片

### Hermes 的做法

**流程**：

```
Agent 需要危险操作
  → 调用 send_exec_approval(chat_id, command, session_key)
  → 发飞书交互卡片（4个按钮：Allow Once / Session / Always / Deny）
  → Agent 阻塞等待
用户点按钮
  → Feishu SDK 回调 _on_card_action_trigger()（同步）
  → 立即返回"resolved card"（按钮变成 ✅/❌ 状态）
  → 异步调用 _resolve_approval(approval_id, choice, user_name)
  → 调 resolve_gateway_approval(session_key, choice) 解除 Agent 阻塞
```

**关键点**：
- 审批卡片通过 `P2CardActionTriggerResponse` 同步更新按钮状态（点完立即变灰/变色）
- `approval_state` dict 维护 `approval_id → {session_key, message_id, chat_id}`
- 无超时，agent 会一直阻塞直到用户响应
- "session" 级别审批后，同 session 内后续危险操作不再弹卡片

**卡片样式**：
- 请求时：橙色 header，代码块展示命令，4个按钮
- 批准后：绿色 header，`✅ Approved [once/for session/permanently] by <用户名>`
- 拒绝后：红色 header，`❌ Denied by <用户名>`

### 我们平台的现状

我们已有类似机制：
- `src/lib/acpx/interactions.ts` — `createTaskRunInteractionRequest()` 创建审批请求
- `src/lib/acpx/interaction-actions.ts` — 处理 approve/deny 动作
- `src/app/api/tasks/[id]/control/route.ts` — HTTP API 接受审批指令
- 飞书侧：`/ap approve <id>` 文本命令已实现（`src/lib/feishu.ts` handleApprovalsCommand）

**缺的是**：
1. Agent 触发审批时，飞书没有主动推送交互卡片（用户需要自己去看 `/ap approvals`）
2. 没有一键点击的按钮卡片，用户必须手动发文字命令

### 实现方案

#### Step 1：审批请求创建时主动推卡片

在 `src/lib/acpx/runner.ts` 的 `handleHarnessInteractionRequest()` 里，`createTaskRunInteractionRequest()` 成功后，找到关联的飞书绑定并发卡片：

```typescript
// 找到当前 liveRoom 的飞书 chatId
const binding = await prisma.feishuConversationBinding.findFirst({
  where: { liveRoom: { sourceTaskId: taskId } },
});
if (binding) {
  await sendFeishuApprovalCard({
    chatId: binding.chatId,
    interactionRequestId: persistedRequest.id,
    command: request.rawContent.slice(0, 500),
    kind: request.kind,
  });
}
```

#### Step 2：新增 sendFeishuApprovalCard()

在 `src/lib/feishu-api.ts` 实现卡片构建 + 发送：

```typescript
export async function sendFeishuApprovalCard(args: {
  chatId: string;
  interactionRequestId: string;
  command: string;
  kind: 'permission_request' | 'input_request' | 'choice_request';
}) {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { content: '⚠️ Agent 请求权限确认', tag: 'plain_text' },
      template: 'orange',
    },
    elements: [
      { tag: 'markdown', content: `\`\`\`\n${args.command}\n\`\`\`` },
      {
        tag: 'action',
        actions: [
          buildBtn('✅ 批准一次', `approve:${args.interactionRequestId}`, 'primary'),
          buildBtn('✅ 本次会话', `approve_session:${args.interactionRequestId}`),
          buildBtn('❌ 拒绝', `deny:${args.interactionRequestId}`, 'danger'),
        ],
      },
    ],
  };
  return sendFeishuInteractiveCard(args.chatId, card);
}
```

#### Step 3：卡片按钮回调处理

飞书卡片按钮点击走 `card_action` 事件。在 `src/lib/feishu.ts` 的事件处理里增加对 `approve:*` / `deny:*` action 的解析，调用现有的 `approveInteractionRequest()` / `denyInteractionRequest()`。

#### Step 4：卡片更新为 resolved 状态

批准/拒绝后，用 `editFeishuMessage()` 把卡片改为绿/红色 resolved 样式（和 Hermes 一样）。

---

## 三、优先级建议

| 功能 | 难度 | 收益 | 建议优先级 |
|------|------|------|-----------|
| 工具进度流（Step 1-2，解析工具事件） | 中 | 高（用户最直观的体验提升） | P0 |
| 工具进度流（Step 3-4，飞书 edit 消息） | 中 | 高 | P0 |
| 飞书审批卡片推送 | 中 | 高（现在用户完全不知道 agent 在等待） | P0 |
| 卡片按钮点击回调 | 中 | 高 | P0 |
| 卡片 resolved 状态更新 | 低 | 中 | P1 |

---

## 四、需要新增/修改的文件清单

**新增：**
- `src/lib/acpx/tool-emojis.ts` — emoji 映射表
- `src/lib/feishu-progress.ts` — FeishuProgressTracker（节流 edit）

**修改：**
- `src/lib/acpx/types.ts` — HarnessStreamCallbacks 增加 `onToolEvent`
- `src/lib/real-agents/claude-agent.ts` — 解析 `tool_use` JSON 事件，调 `onToolEvent`
- `src/lib/real-agents/codex-agent.ts` — 同上（Codex 有 tool_call 事件格式）
- `src/lib/acpx/runner.ts` — `handleHarnessInteractionRequest` 触发飞书卡片推送
- `src/lib/feishu-api.ts` — 新增 `editFeishuMessage()`, `sendFeishuApprovalCard()`, `sendFeishuInteractiveCard()`
- `src/lib/feishu.ts` — 增加卡片按钮回调处理（approve/deny action）
- `src/lib/live-room-delivery.ts` — 把 FeishuProgressTracker 接入 streamCallbacks

---

## 五、参考：飞书 Edit Message API

```
PATCH https://open.feishu.cn/open-apis/im/v1/messages/{message_id}
Authorization: Bearer {tenant_access_token}
Content-Type: application/json

{
  "msg_type": "text",
  "content": "{\"text\": \"新内容\"}"
}
```

Interactive card 发送用 `msg_type: "interactive"`，`content` 为 card JSON 字符串。

---

## 六、紧急 BUG：Claude 在 Live Room 里频繁超时

### 现象

用户反复看到：`系统提示：claude 本次回复失败：Claude execution timed out after 600000ms`

### 根因（4 层）

**根因 1：非对称超时配置 — Claude 10 分钟，Codex 无限制**

`src/lib/live-room-delivery.ts:492`（修复前）：
```typescript
const watchdogConfig =
  participant.executionBackend === 'platform_local' && participant.harnessType === 'codex'
    ? { maxRuntimeMs: null }   // Codex 无限 ✅
    : undefined;               // Claude 回退默认 600000ms ❌
```

这个非对称没有任何注释解释原因，属于历史遗留。

**根因 2：超时后 participant 被标为 `failed`，下次无法续接**

`src/lib/acpx/session-tracking.ts:140`：
```typescript
if (candidate.status !== 'completed') return false;
```

Claude 超时 → `executeParticipant` catch 块 → participant.status = `failed` → `findLatestParticipantSession` 过滤掉 → **每次都是全新启动，上下文全丢**。

**根因 3：超时 retry 仍用相同超时 — 死循环**

`shouldRetryWithFreshSession` 检测到 `timed out after \d+ms` 触发 fallback fresh retry，但新 run 的超时还是 600000ms，不断循环。

**根因 4：SIGTERM 后立即 reject，session ID 最终状态丢失**

`src/lib/real-agents/claude-agent.ts:410-417`：
```typescript
setTimeout(() => {
  settled = true;
  child.kill('SIGTERM');
  reject(new Error(`Claude execution timed out after ${options.timeout}ms`));
}, options.timeout);
```

`settled=true` 之后 `close` 事件里 `if (settled) return` 跳过，最终 session 状态无法写入。

### 已实施的修复

`src/lib/live-room-delivery.ts:492`（2026-04-18）：

```typescript
// 修复：platform_local 的所有 agent（包括 claude）都禁用超时
const watchdogConfig =
  participant.executionBackend === 'platform_local'
    ? { maxRuntimeMs: null }
    : undefined;
```

### 遗留问题（下个 session 跟进）

1. **超时时 participant 状态应标为 `interrupted` 而非 `failed`**，以便续接。需修改 `claude-agent.ts` timeout handler，在 SIGTERM 后等 close 事件再 reject，让 session ID 有机会写入，并在 `executeParticipant` 里识别 timeout → `interrupted`。
2. **remote_ssh Claude 还是有超时**（`watchdogConfig = undefined` → 默认 10 分钟）。如需支持长任务，需在 SSH executor 层也支持可选的无超时配置。
3. **`resolveHarnessTimeout(null, default)` 返回 `null`**，而 `claude-agent.ts` 里 `setTimeout(fn, null)` 会立即触发。需确认 runner.ts 里对 `timeout=null` 的处理路径正确（当前 `resolveHarnessTimeout` 返回 null 时不传 timeout 给 execute 函数，但 `claude-agent.ts` 的默认值是 `60000`ms — 需核查）。

---

## 七、Session 续接与 Context Window 管理（已实施 + 待续）

### 已实施（2026-04-18）

**恢复 Codex thread 续接**（`src/lib/live-room-delivery.ts`）：
- 移除了 `shouldPreferTranscriptContinuation` 对本地 Codex 的硬绑定（之前强制每次全新启动）
- 现在 Claude 和 Codex 都走统一的三层降级策略：
  1. **优先**：续接上次 thread/session（`--resume sessionId` / `codex exec resume threadId`）
  2. **降级**：thread 失效时，标记 stale，fresh start + task room transcript 注入
  3. **兜底**：Codex local state 损坏时，forceEphemeral 完全干净启动

**Context watermark 双档位**（`src/lib/acpx/runner.ts`）：
- 软警告（>40条消息 / >200事件）：提示用户考虑 `/ap new-session`
- 硬警告（>60条消息 / >400事件）：直接指令 agent 完成当前任务后输出摘要并告知用户切换

### 待实现：Auto-Compact + Summary Handover

当前 context 超载时，agent 只收到文字指令，没有系统级的自动化接管。下一步应实现：

**目标**：watermark 触发时，agent 输出结构化 summary → 自动存入 task description → 新 session 以 summary 作 preamble 启动。

**实现方案**：

1. **约定 summary 格式**：在 hardWatermark 指令里要求 agent 输出特定格式：
   ```
   [COMPACT_SUMMARY_START]
   已完成：...
   关键发现：...
   下一步：...
   [COMPACT_SUMMARY_END]
   ```

2. **解析 summary**：在 `onStdoutChunk` 回调里检测 `[COMPACT_SUMMARY_START]...[COMPACT_SUMMARY_END]`，提取内容。

3. **持久化 summary**：把 summary 写入 `task.description`（追加，不覆盖）。

4. **新 session preamble**：`buildHarnessPrompt` 里，若 `task.description` 包含 compact summary，优先作为第一段注入。

**Claude Code 原生 compaction**（可选替代方案）：
Claude Code CLI 支持 `--dangerously-force-compaction` 标志，可以在 context 满时自动压缩对话历史。但这是破坏性操作（旧对话不可恢复），需谨慎。Codex 没有等价功能，需用上述 summary 方案。

**关键文件**：
- `src/lib/acpx/runner.ts` — `checkContextWatermark` + `buildHarnessPrompt`（注入 summary preamble）
- `src/lib/live-room-delivery.ts` — `onStdoutChunk` 里解析 `[COMPACT_SUMMARY]`
- `prisma/schema.prisma` — `Task.description` 字段（已有，直接复用）
