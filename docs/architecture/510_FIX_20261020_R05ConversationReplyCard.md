---
doc_type: FIX
doc_status: completed
---

# R05 补图后的答复被旧阻塞卡片遮住

## 现场与根因

基线 `9526719`。2026-10-20 14:52，用户在 R05 话题补图并询问“一张够不够”。平台已下载图片、绑定 `conversation_input`，由原任务的 Codex 会话处理，14:53 保存完整答复。答复指出该图为三段熔胶页，与待验收的白色五段储料射退页不同，因此未请求解除原材料暂停。实际查看原图与该判断一致。

用户看到的首屏却是旧“需你确认 / 缺材料”说明。飞书回读确认，具体答复位于默认折叠的“展开本轮回复”。故障发生在投影层，不是本次图片没有进入会话，也不是恢复预算被耗尽。事实和原卡片见 [case.json](../evidence/r05-conversation-card/case.json)。

`run-reply-relay` 没有区分后续聊天与实施进度，将同一 execution 的旧 `lastFailure` 交给 `buildRunReplyCard`。后者优先显示失败说明，所有 Agent 回复都被折叠，导致每轮问答看起来仍是平台默认信息。

## 修复边界

- `run-reply-relay.ts` 从既有 `conversation_followup_bound` 事件识别后续会话。必须同时匹配 run、node、execution 和 TaskRun，不依赖自然语言或可被下一轮覆盖的临时 conversation 字段。
- `run-reply-card.ts` 让聊天答复和运行中输出出现在首屏。任务交付状态保留在独立折叠区，聊天完成不表示任务通过。恢复控制行不进入聊天正文。
- 普通实施卡片、失败说明、流式游标、消息发送幂等键保持原机制。没有修改图片权限、sandbox、恢复入口、候选、claim/revision 或预算。
- 两个已有测试增加回归。持久绑定清理后仍能正确识别聊天；其他 execution 的绑定不能误认本轮；重复轮询不重发、不改变 execution。

## 验证

在独立 worktree 和 runner 临时 PostgreSQL schema 中运行同一回归：

| 检查 | 结果 |
| --- | --- |
| 基线上的真实卡片重放 | exit 1，首屏缺少本轮图片判断；[日志](../evidence/r05-conversation-card/replay-red.log) |
| 修复后的同一重放 | exit 0，三个答复段落直接可见；[日志](../evidence/r05-conversation-card/replay-green.log) |
| 基线上的 card-closure 回归 | exit 1，已绑定聊天仍显示旧阻塞；[日志](../evidence/r05-conversation-card/relay-red.log) |
| card-closure / feishu-relay / failure-summary / reply-summary | exit 0；[日志](../evidence/r05-conversation-card/green.log) |
| TypeScript、长文件、源码空白检查 | exit 0 |

日志中的一次 `Notification send uncertain` 来自原有“发送成功但响应丢失”反例，该反例验证不重复发送，不是新增测试失败。

## 限制与线上核验

这次修复保证用户看到具体答复，不把不符合验收要求的图片自动当成合格材料。历史会话若没有持久绑定事件，继续使用原进度投影，不能从回复文字猜测用途。

上线只刷新卡片投影，不接续 R05、不修改其业务执行账本、不消耗恢复预算。线上卡片回读及执行状态比较另保存在本次诊断输出目录 `output/reviews/r05-image-followup-20261020/`。
