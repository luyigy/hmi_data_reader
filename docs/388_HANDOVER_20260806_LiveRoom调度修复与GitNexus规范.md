---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/383_PLAN_20260804_Inbox优先级议题实施.md
slice: S05
plan_progress: complete
---

# Live Room 调度修复、飞书命令扩展与 GitNexus 项目规范文档

> **文档标识**: `docs/388_HANDOVER_20260806_LiveRoom调度修复与GitNexus规范.md`  
> **更新时间**: 2026-08-06  
> **适用范围**: agent-platform-v2 及其他需集成 Multi-Agent Live Room / GitNexus 规范的项目参考  

---

> **⚠️ 验证与实测状态特别说明**：
> 1. **单元测试验证已通过**：Role Queue 目标路由调度 (`tests/live-room-scheduling.test.ts`)、飞书 Key-Value 命令拆分 (`tests/feishu-mode-command.test.ts`) 以及 Codex 思考过程增量过滤 (`tests/feishu-progress-system-info.test.ts`) 的自动化单元测试均已通过。
> 2. **真实环境待验证 (Unverified in Live Room)**：本次针对 `execution` 模式的路由卡死与回复送达修复，在真实飞书 Live Room 环境中的**实际交互效果目前尚未完成人工/端到端实测验证**。提交后需要再进一步观察并验证真实 Live Room 中的 `execution` 模式调度情况。

---

## 目录
1. [变更一：Live Room Role Queue 目标路由与重复送达修复](#1-变更一live-room-role-queue-目标路由与重复送达修复)
2. [变更二：飞书命令参数语法兼容 (`/ap key=value`) 与消息幂等](#2-变更二飞书命令参数语法兼容-ap-keyvalue-与消息幂等)
3. [变更三：GitNexus 规范化配置与防盲目执行策略](#3-变更三gitnexus-规范化配置与防盲目执行策略)
4. [变更四：Live Room Codex 思考过程增量与过滤优化](#4-变更四live-room-codex-思考过程增量与过滤优化)
5. [其他仓库配置与移植复用指南](#5-其他仓库配置与移植复用指南)

---

## 1. 变更一：Live Room Role Queue 目标路由与重复送达修复

### 1.1 问题现象与根因
在 Live Room `execution` 模式下，当房间存在多个 Agent（例如 5 个 Agent）并触发 Role Queue 顺序回复时：
- **缺陷表现**：若房间设置了 `currentSpeakerMemberId`（即记录了上一次发言的 Agent，例如 Codex），当系统依次触发 Role Queue 中下一个目标 Agent（如 Claude、DeepSeek）时，`getPrimaryReplyTarget` 解析回复目标的 `preferRequestedTarget` 默认为 `false`。
- **导致的死锁循环**：由于未优先使用传入的 `requestedTargetMemberId`，路由算法默认回退并匹配了 `room.currentSpeakerMemberId` (Codex)。这导致 Role Queue 遍历队列中的每一项时，全部被重新重定向给了 Codex，Codex 被连续触发 5 次完全相同的消息，频繁输出`“重复送达，无动作。待命中...(第 5 次)”`。

### 1.2 修复要点与代码位置
1. **显式目标优先匹配** (`src/lib/live-room-delivery-routing.ts`)
   - 将 `getPrimaryReplyTarget` 的 `preferRequestedTarget` 默认参数逻辑调整为 `Boolean(requestedTargetMemberId)`。
   - 只要调用方显式传了 `requestedTargetMemberId`，优先尝试匹配该目标成员，不再强制回退到 `currentSpeakerMemberId`。

2. **Role Queue 锁定对应成员** (`src/lib/live-room-delivery.ts`)
   - 在 `triggerLiveRoomAgentReply` 和 `triggerLiveRoomMessageReplies` 中，对 Role Queue 调度强制锁定 `forceTargetMember: isMentionAll || isRoleQueue`，确保队列中的每个 Agent 依次正确响应各自的 Turn。

3. **单元测试验证** (`tests/live-room-scheduling.test.ts`)
   - 补充自动化单元测试：在 `execution` 模式且存在 `currentSpeakerMemberId` 的场景下，验证 Role Queue 依次传入 `targetMemberId` 时能够 100% 精准分发到对应成员。

---

## 2. 变更二：飞书命令参数语法兼容 (`/ap key=value`) 与消息幂等

### 1.1 问题现象与根因
1. **命令解析失效导致的模式无法切换**：
   - 用户在飞书中尝试发送 `/ap mode=discussion` 切换房间模式时，原解析器仅匹配空格分隔（如 `/ap mode discussion`）或 `--key=val` 命令行标志。对 `/ap mode=discussion`，解析器将整体当成了命令名 `"mode=discussion"`，因未识别出命令而返回 `null`。
   - **连锁反应**：消息未能作为系统命令被拦截，而是被当成普通聊天消息插入了 Live Room。由于房间模式未成功切回 `discussion`，继续保持在 `execution` 模式，该普通消息再次触发了全员 Role Queue 遍历。
2. **飞书双通道/重试重复**：
   - 飞书长连接（WS）与 Webhook 双通道或者网络超时重试时，相同 `feishuMessageId` 可能会重复进入入库流程。

### 2.2 修复要点与代码位置
1. **支持 `/ap key=value` 命令语法** (`src/lib/feishu-command-parser.ts`)
   - 增强 `parseFeishuCommand`，当识别到 `/ap` 后第一个词包含 `=`（如 `/ap mode=discussion`）时，自动将其切割为命令名 `mode` 与参数 `discussion`。
2. **飞书消息幂等防重** (`src/lib/feishu-live-room.ts`)
   - 在 `postFeishuMessageToBoundLiveRoom` 入口查重 `feishuMessageId`，遇到已存在的消息唯一 ID 时直接忽略，防止重复入库与二次触发。
3. **单元测试验证** (`tests/feishu-mode-command.test.ts`)
   - 增加对 `/ap mode=discussion` 等 `=` 参数连接语法的解析单元测试。

---

## 3. 变更三：GitNexus 规范化配置与防盲目执行策略

### 3.1 背景与痛点
1. **自动覆写问题**：GitNexus CLI 在运行 `analyze` 指令时，默认会自动在根目录 `AGENTS.md` 中注入/覆盖大量的 Agent 强制规则（如“修改任何 Symbol 前必须运行 impact”）。
2. **过度分析问题**：AI Agent 如果无差别地在每次微小 Bug 修复前都运行 GitNexus `impact` 分析，会导致全盘扫描延迟高、Token 消耗大，严重影响简单任务的完成效率。

### 3.2 解决方案与配置规范
1. **配置 `.gitnexusrc` 阻止自动改写**：
   在根目录下增加 `.gitnexusrc` 文件：
   ```json
   {
     "skipAgentsMd": true
   }
   ```
   **作用**：关闭 GitNexus 在分析时自动修改/覆盖 `AGENTS.md` 的行为。

2. **在 `AGENTS.md` 中显式定义 GitNexus 使用准则**：
   在 `AGENTS.md` 头部新增 `## GitNexus Usage` 规则，按需触发：
   ```markdown
   ## GitNexus Usage

   GitNexus is an available code analysis tool, but it should not be executed blindly for every task.

   Use GitNexus only when the task requires deeper impact analysis, such as:
   - modifying shared modules or public APIs;
   - changing authentication, permission, database schema, workflow, or core architecture;
   - performing large refactoring across multiple features;
   - the dependency impact cannot be understood through normal code navigation.

   For small, isolated changes:
   - do not automatically run GitNexus;
   - use normal repository exploration tools first;
   - avoid unnecessary repository-wide analysis.

   GitNexus results should support engineering decisions, not replace understanding of the actual code path.
   ```

---

## 4. 变更四：Live Room Codex 思考过程增量与过滤优化

### 4.1 修复要点与代码位置
- **代码位置**：`src/lib/live-room-delivery-execution.ts` & `tests/feishu-progress-system-info.test.ts`
- **改进功能**：
  1. `shouldRelayLiveRoomStdoutProgress` 增加了对 `codex` harness 的支持，允许将 Codex 的 stdout/thinking 实时呈现给卡片。
  2. 引入 `isUsefulLiveRoomThinkingPreview` 过滤算法（判断文本长度 $\ge 80$ 或是否包含句号/问号/叹号等有效断句），避免推送单个字符或未形成完整意思的中间片段，提升卡片可读性。

---

## 5. 其他仓库配置与移植复用指南

如需在其他 Git 仓库中落地上述优化与规范，可按以下步骤快速复用：

### 5.1 复用 GitNexus 防覆写与规范控制
1. **新建 `.gitnexusrc`**：
   在目标仓库根目录新建 `.gitnexusrc` 文件并写入：
   ```json
   {
     "skipAgentsMd": true
   }
   ```
2. **更新 `AGENTS.md`**：
   将 `AGENTS.md` 顶部的 `## GitNexus Usage` 规则粘贴过去，防止 AI Agent 每次轻量修改时盲目执行耗时分析。

### 5.2 复用命令解析与幂等处理模式
1. **Key-Value 命令分割器设计**：
   在处理 `/slash` 或 `/ap` 类交互命令时，应对首个参数做 `=` 拆分逻辑：
   ```typescript
   if (rawCmd.includes('=')) {
     const [cmd, val] = rawCmd.split('=', 2);
     command = cmd;
     args.unshift(val);
   }
   ```
2. **Webhook / 长连接消息幂等**：
   对于所有从 IM / 外部系统接收的消息，入库前统一使用外部系统的 `messageId` 进行 Unique 索引查重或 Redis / DB 幂等拦截。

---
*修改涉及文件汇总*：
- `src/lib/live-room-delivery-routing.ts`
- `src/lib/live-room-delivery.ts`
- `src/lib/live-room-delivery-execution.ts`
- `src/lib/feishu-command-parser.ts`
- `src/lib/feishu-live-room.ts`
- `tests/live-room-scheduling.test.ts`
- `tests/feishu-mode-command.test.ts`
- `tests/feishu-progress-system-info.test.ts`
- `AGENTS.md`
- `.gitnexusrc`
