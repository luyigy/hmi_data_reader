---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/383_PLAN_20260804_Inbox优先级议题实施.md
slice: S04
plan_progress: complete
---

# HANDOVER · 飞书 Live Room 系统提示折叠与消息过滤修复

## 1. 完成内容

### 问题定位
在飞书 Live Room 执行流程中：
- Agent 思考/分析产生的 `member_reply_thinking` 以及 `member_reply_started` / `heartbeat` 系统事件虽然被写入了卡片中 **「⚙️ 系统信息详情」** 面板，但由于向数据库写入系统消息时缺少 `skipFeishuRelay: true` 标记，且底层 relay 逻辑未过滤 `member_reply_thinking` 与 `member_reply_tool`，导致系统将该思考/工具调用日志作为独立的飞书文本消息重复推送，显示在折叠面板之外。

### 修复措施

1. **飞书 Card 聚合支持 (`src/lib/feishu-progress.ts`)**
   - 在 `FeishuProgressTracker` 中新增 `systemEntries` 记录系统事件日志。
   - `updateCard()` 与 `finalize()` 中增加 **「⚙️ 系统信息详情」** `collapsible_panel` 折叠面板，统一收纳思考分析、任务启动、心跳保活、自动重试等系统事件。

2. **系统消息跳过独立 Relay (`src/lib/live-room-delivery-execution.ts`)**
   - 在 `progressTracker` 激活时（即飞书卡片交互模式下），为任务启动 (`member_reply_started`)、心跳保活 (`heartbeat`)、思考分析 (`member_reply_thinking`) 等系统消息统一注入 `skipFeishuRelay: true` 标记，防止其独立向飞书发送文本消息。

3. **底层转发过滤规则 (`src/lib/feishu-live-room-relay.ts`)**
   - 更新 `shouldRelayLiveRoomMessage` 规则，显式阻断带有 `skipFeishuRelay: true` 的消息，以及 `member_reply_thinking` 和 `member_reply_tool` 独立文本消息转发。

4. **自动化单元测试与校验**
   - 新增 `tests/feishu-progress-system-info.test.ts` 验证系统事件在飞书卡片 JSON 结构中的折叠与解析逻辑。
   - 更新 `tests/feishu-live-room-relay.test.ts` 验证 relay 逻辑阻断与过滤规则。

## 2. 验证结果

- `npx ts-node tests/feishu-live-room-relay.test.ts` 验证通过。
- `npx ts-node tests/feishu-progress-system-info.test.ts` 验证通过。
- `npm run check:long-files` 阻断阈值检查无异常。
- 飞书 Live Room 在线服务重启后实测，系统提示与思考过程已完全收纳进卡片折叠面板中，不再溢出为独立的文本消息。

## 3. 修改文件

- [`src/lib/feishu-progress.ts`](file:///data1/code/agent-platform-v2/src/lib/feishu-progress.ts)
- [`src/lib/live-room-delivery-execution.ts`](file:///data1/code/agent-platform-v2/src/lib/live-room-delivery-execution.ts)
- [`src/lib/feishu-live-room-relay.ts`](file:///data1/code/agent-platform-v2/src/lib/feishu-live-room-relay.ts)
- [`tests/feishu-progress-system-info.test.ts`](file:///data1/code/agent-platform-v2/tests/feishu-progress-system-info.test.ts)
- [`tests/feishu-live-room-relay.test.ts`](file:///data1/code/agent-platform-v2/tests/feishu-live-room-relay.test.ts)
