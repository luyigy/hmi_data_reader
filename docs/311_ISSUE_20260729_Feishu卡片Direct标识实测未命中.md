---
doc_type: ISSUE
doc_status: resolved
next_action: none
---

# ISSUE · Feishu 卡片 Direct 标识实测未命中

## 状态说明

本文记录 Feishu DM `08a216`（chat id
`oc_b634823504e29e6220de0cfb5108a216`）的真人验收失败、根因复核和最终结论。
它不是可执行 PLAN，workflow watcher 不应据此启动新 Session 或执行 Slice。

截至 2026-07-29 16:23（Asia/Shanghai）：

- Feishu 卡片标题仍未出现用户期望的 `Direct/私聊回复`；
- 提交 `936cc87` 的代码和单元测试均正常，但真人测试消息没有进入该代码分支；
- 已确认普通 Feishu DM 回复按现有产品语义是 Broadcast，不是 Agent-to-Agent Direct；
- 16:04 的 Agent 间对话测试把 `$claude` 放在 Markdown 反引号中，因此未触发 handoff；
- 16:21 使用裸 `$claude` 后已成功形成结构化 handoff，并收到 Claude 回复。

## 用户期望与实际现象

用户希望从 Feishu 卡片上看出消息去向，并进一步观察 Agent 间对话卡片如何展示。

本轮曾把 Codex 对用户的普通回复当成 Direct 卡片来验收，先后发送：

- 15:51：`DM-DIRECT-08a216-SMOKE`
- 16:01：`DM-DIRECT-08a216-RETEST`

两次真人观察均没有看到 `Direct/私聊回复`。16:04 又在 Codex 回复中以 Markdown 行内代码形式输出
`` `$claude` ``，运行日志能识别出 `claude` mention，但 handoff 解析器不会把代码引用当作控制指令，
所以消息保持 Broadcast。

## 已确认根因：验收消息不是 Direct

`buildAssistantRelayCard` 只有同时满足以下条件时才显示 Direct 标题：

```text
metadata.deliveryIntent === "directed_visible"
且 metadata.targetMemberName 有效
```

但数据库中 15:51、15:56、15:58、16:01、16:04 的五条 Codex assistant 消息全部是：

```text
visibility = room
metadata.deliveryIntent = broadcast
metadata.targetMemberName = null
```

因此这些卡片必然走默认标题 `senderName`。`936cc87` 增加的
`Direct/私聊回复 · 发送者 → 目标` 分支在真人验收中一次也没有被命中。

这不是 Feishu 客户端缓存，也没有证据表明服务仍在运行旧代码。真正的问题是产品期望与当前
`directed_visible` 判定语义不一致：

- 当前实现用开头的明确 `@member` 表示 Agent-to-Agent `directed_visible`，裸 `$member` 表示
  handoff；
- Codex 对 Feishu 用户消息的普通回复虽然来自一次定向给 Codex 的 delivery，但输出本身没有以目标
  member mention 开头，所以被保存为 Broadcast；
- 当前实现不会因为 `replyToMessageId`、原 delivery 的目标或“这是 Feishu 私聊”就把回复标成 Direct。

换言之，本轮修改的是“结构化 Agent-to-Agent Direct 卡片”的标题，但真人验收实际在看“Agent 对
Feishu 用户的普通回复”。两者不是同一种消息语义。

## 已做改动

### 提交 `04c09de`：区分 Broadcast、Direct 与 Handoff

涉及：

- `src/lib/feishu-live-room-relay.ts`
- `src/lib/live-room-delivery-processing.ts`
- `tests/feishu-live-room-relay.test.ts`
- `tests/live-room-handoff-boundaries.test.ts`

行为变化：

- 卡片不再用 `message.visibility` 猜测 Direct，只认结构化 `metadata.deliveryIntent`；
- `directed_visible` 且目标名称有效时，标题显示 `发送者 → 目标`；
- `handoff` 且目标名称有效时，标题保持发送者，并增加 `下一位：目标` note；
- delivery processing 为 handoff 补充目标成员显示名称；
- 增加 Broadcast、Direct、Handoff、非法/缺失 metadata 的聚焦断言。

该提交解决的是旧逻辑可能把 Handoff 误画成 Direct 的问题，不负责把普通 Feishu DM 回复转换成
Direct。

### 提交 `936cc87`：给 Direct 标题增加显式标签

涉及：

- `src/lib/feishu-live-room-relay.ts`
- `tests/feishu-live-room-relay.test.ts`

唯一行为变化：

```text
发送者 → 目标
```

改为：

```text
Direct/私聊回复 · 发送者 → 目标
```

该提交只改了已存在的 `directed_visible` 分支及对应断言，没有修改消息分类、delivery、数据库、
relay binding 或 Feishu API。

## 验证事实

- `936cc87` 是当前 `oss-prep` HEAD。
- `agent-platform-feishu.service` 于 15:57 重启，16:08 检查仍为 `active`。
- 15:57 启动日志显示 Feishu runtime 正常进入 `running / long_connection / healthy`。
- `tests/feishu-live-room-relay.test.ts` 在当前 HEAD 再次运行通过。
- `npm run check:long-files` 通过，无 1000 行及以上文件。
- 运行日志没有 `Failed to relay live room message to Feishu`。
- 数据库事实证明真人测试消息均为 Broadcast；因此“重启后仍不显示”不能证明新代码未加载。

先前 S01 的完整实现与验证记录见：

- `docs/309_PLAN_20260729_Feishu卡片消息去向与接力提示.md`
- `docs/310_HANDOVER_20260729_Feishu卡片消息去向与接力提示S01完成.md`

## 已解释现象：16:04 的 `$claude` 没有形成 Agent 间对话

16:04 的 Codex 输出包含 Markdown 行内代码 `` `$claude` ``，日志中的 Mention Detection 成功解析到
Claude member：

```text
memberId = cms5r3gnq00taqpwo2zbct9vf
matchedAlias = claude
```

但对应 `LiveRoomMessage` 仍保存为：

```text
visibility = room
deliveryIntent = broadcast
handoffToMemberId = null
targetMemberName = null
```

复核数据库后确认，该轮 source message 和 delivery 都已有正确的 `handoffRootMessageId`：

```text
source message = cms5st79c004fjo8jt4e6zlte
delivery = cms5st7ae004jjo8jz056w8r9
delivery.handoffRootMessageId = cms5st79c004fjo8jt4e6zlte
```

因此门槛没有吞掉 handoff。真正原因是 `detectLiveRoomHandoffIntent` 只接受位于文本开头、空白或左括号
之后的裸 `$member`；反引号内的 `$member` 是文档引用，不是可执行控制指令。

16:21 的 Codex 回复在末尾输出裸 `$claude` 后，同一套路径已成功：

```text
assistant message = cms5tgakj00ltjo8jfdrabwxz
deliveryIntent = handoff
handoffToMemberId = cms5r3gnq00taqpwo2zbct9vf
handoffClaimStatus = accepted
handoffTargetMemberId = cms5r3gnq00taqpwo2zbct9vf
next delivery = cms5tgamu00lyjo8j73ijmpe3 (delivered)
```

随后 Claude 回复 `cms5thqil00mxjo8j46ub5vbi` 已落库。当前普通 `$member` handoff 行为符合
`docs/290_ISSUE_20260728_AgentMention受控异步接力.md` 和
`docs/296_PLAN_20260728_LiveRoom受控接力Codex遥测与长文件治理.md` 的协议，无需修改业务代码。

## 最终结论

1. `Direct/私聊回复` 按 `docs/309_PLAN_20260729_Feishu卡片消息去向与接力提示.md` 只表示结构化
   Agent-to-Agent `directed_visible`，不表示 Agent 对 Feishu 私聊用户的普通回复。
2. 普通 Feishu DM 回复保持 Broadcast 是当前既定语义，不应再通过修改标题字符串纠偏。
3. Agent 间接力应输出裸 `$member`；Markdown 反引号中的 `` `$member` `` 只作可见引用。
4. 若产品希望卡片额外展示“来自私聊渠道”，应新建 PLAN，从 binding/source metadata 增加独立的渠道
   语义；不要复用 `directed_visible` 或从 assistant 正文猜测。
5. 本次复核不需要业务代码修改、服务重启、数据库写入或新的真人消息。

## 工作区与边界

- 本 ISSUE 不回滚 `04c09de` 或 `936cc87`；两者满足原定义的 Agent-to-Agent Direct/Handoff 卡片语义，
  但不实现普通 Feishu DM 的渠道标签。
- 本 ISSUE 不修改业务代码、不重启服务、不发送新的真人测试消息。
- 开工前已有的 `AGENTS.md`、`CLAUDE.md` 和 `.codex-tmp/` 属于用户改动，未纳入本次文档提交范围。
- 若后续决定改变消息分类语义，应新建 PLAN；不要把本文直接当作 workflow 可执行文档。
