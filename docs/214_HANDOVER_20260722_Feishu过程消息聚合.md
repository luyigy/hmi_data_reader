# 214_HANDOVER_20260722_Feishu过程消息聚合

## 任务类型
bugfix

## 所属主线
临时插队；阻塞当前 Feishu Live Room 过程消息体验，必须立即修。

## 为什么做
2026-07-22 12:24 重启 `agent-platform-feishu.service` 后，Codex 的 stdout token delta 被逐条转发为飞书新消息，出现“我 / 启动 / Git / 现”式结巴刷屏。

根因不是 STDERR，也不是网络：Codex app-server 的 `item/agentMessage/delta` 是增量分片，而当前过程消息链路把分片当成完整消息。

## 当前状态
工作区有两轮未提交尝试，行为尚未统一：

- `src/lib/feishu-live-room-relay.ts` 当前过滤所有 `member_reply_progress`，能止住刷屏，但也会让完整过程说明消失。
- `src/lib/live-room-delivery.ts` 当前为 Codex stdout 累积分片，并在 8 秒、工具事件前、失败或结束时冲刷；但上面的 relay 过滤会使聚合结果无法到达飞书。
- `tests/feishu-live-room-relay.test.ts` 当前断言所有 harness 的 progress 都不转发，与“聚合后恢复 Codex 过程说明”的方向冲突。

不要直接把这三处现状当成已完成修复。

## 建议改法
目标是保留有意义的 Codex 过程说明，同时不逐 token 发消息。最小闭环：

1. 在 `executeLiveRoomReplyViaAcpx` 的共享出口聚合 Codex stdout delta，不在 parser 或每个调用方分别打补丁。
2. 聚合窗口到期、工具事件前、执行失败前、最终回复前必须冲刷，保证不丢字且顺序正确。
3. 给聚合后的 progress metadata 保留 `harnessType: 'codex'` 和 `stream: 'stdout'`。
4. 调整 `shouldRelayLiveRoomMessage`：只允许明确标记为“已聚合”的 Codex stdout progress；旧消息、其他 harness progress、Codex stderr 仍过滤。建议新增一个布尔 metadata（如 `aggregated: true`），不要靠文本内容猜测。
5. 更新 relay 测试：`aggregated: true` 的 Codex stdout 应为 `true`，其余 progress 为 `false`。

Ponytail 边界：不新增类、依赖或通用流处理框架；沿用现有队列和 `LIVE_ROOM_PROGRESS_MIN_INTERVAL_MS` 即可。

## 修改前必须做
遵守仓库 `AGENTS.md`：编辑符号前先跑 GitNexus upstream impact，并向用户报告 direct callers、affected processes 和 risk。至少检查：

- `executeLiveRoomReplyViaAcpx`
- `shouldRelayLiveRoomMessage`

若 impact 为 HIGH/CRITICAL，先警告再继续。

## 验证结果
上一轮曾报告以下检查通过，但下一 session 改完后必须重新执行：

```bash
npx tsc --noEmit
git diff --check
```

还应运行项目现有方式可执行的相关测试；不要新增 runner 或依赖。最终手工验收：

1. 重启 `agent-platform-feishu.service`。
2. 从飞书发起一次会产生较长 Codex commentary 和工具调用的请求。
3. 确认没有逐 token 新消息；过程说明按整段出现；工具事件和最终回复顺序正确；末尾不足 8 秒的内容没有丢失。
4. 提交前运行 GitNexus `detect_changes({scope: "compare", base_ref: "master"})`，区分本修复与工作区已有改动。

## 已知时间线
- 2026-04-12：加入 stdout/stderr 过程消息；当时 CLI 通常输出较大日志块。
- 2026-07-22 08:32：数据库首次观察到 Codex token 碎片。
- 2026-07-22 09:44：Codex 切到 app-server delta 路径。
- 2026-07-22 12:15–12:18：本地未提交改动放开 Codex progress。
- 2026-07-22 12:24：Feishu 服务重启，新行为生效。
- 2026-07-22 12:33：用户截图确认逐 token 刷屏。

## 工作区提醒
当前工作区还有其他未提交文件和数据库备份，均不要顺手清理或覆盖。与本问题直接相关的现有修改是：

- `src/lib/feishu-live-room-relay.ts`
- `src/lib/live-room-delivery.ts`
- `tests/feishu-live-room-relay.test.ts`

`src/lib/real-agents/codex-event-parser.ts` 及其测试也有未提交修改，但是否属于本问题需先看 diff，不能假定可回退。

## 对主线的影响
问题尚未闭环；当前可止住刷屏，但“飞书显示聚合后的完整过程说明”仍待实现和手工验收。

## 下一步建议
新 session 先读本文和上述三个相关 diff，完成 impact 后统一 relay 与 delivery 的契约，再测试、重启服务并从飞书实测。不要先继续叠加第三套方案。
