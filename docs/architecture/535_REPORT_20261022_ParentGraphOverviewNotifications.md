# 主会话总览与状态刷屏修复

## 现场结论

2026-10-22 09:18 UTC 读取原 Reader/Mold 路线账本，24 个节点分别是 16 passed、2 claimed、3 planned、3 attention。BOLE 和 ARBURG 当时正在实施。NISSEI、FANUC、YIZUMI 是三个 attention，不能称所有任务都已启动。

上一轮 `eb92bb6` 的飞书切换已完成，部署回执有新 PID、启动日志、健康检查及通知读回。本次刷屏属于通知出口的遗留行为。

## 调用链

```text
Coordinator 每轮启动 / 集成 / 验收
  -> postGraphParentProgress
  -> 主房间 system 消息，systemEvent = task_graph_progress
  -> shouldRelayLiveRoomMessage
  -> 旧逻辑允许所有此类系统消息逐条发送到飞书

独立的 publishGraphOverview
  -> 读取同一账本
  -> 更新已记录 messageId 的原卡片
```

总览卡确实在更新，但旧广播出口没有随它关闭。缺口在飞书投递层，不需要改变 Ticket 调度、批准或 Writer。

## 代码与回归

修复代码为 `5211562b885040174aeb1618d6a976fc4e860139`。`src/lib/feishu-live-room-relay.ts` 在统一出口对 `task_graph_progress` 返回 false，两行改动。内部消息仍存入原历史，飞书进度只由原总览卡承载。没有按 Ticket 名称或中文消息文本匹配。

保留原 Agent 消息、提问、子话题细节、总览定向回复、人工验收卡、权限校验和幂等回执。每条路线复用自己的卡片；不删除其他历史路线卡片。

红色回归证实旧出口返回 true。绿色回归验证出口返回 false；T3 经实际 postGraphParentProgress 写入两条内部历史，再走真实 relay，远端文本发送数仍为零，总览新建卡数仍为一。原卡更新、权限拒绝、分页、暂停期间存储和原 Agent 输入仍通过。

通过两个 PostgreSQL 隔离套件 T3 / notification-recovery，以及 relay、TypeScript、长文件检查。原 relay 全套测试还有一个与本次无关的旧 PLAN 按钮断言，基线复现后将测试对齐已上线的“只有范围说明、不再提供 PLAN 按钮”行为，没有恢复旧工作流。证据见 `docs/evidence/graph-parent-notification-20261022/`。

## 生产观察

只向 Coordinator 的实际 Node PID 发 SIGTERM。既有处理器停止领取新轮次并等待 inflight 结束，未向 Agent 子进程发停止信号。旧 Node 4112940 退出后，systemd 在 09:25:14 UTC 启动新服务，MainPID 为 125230。

原总览卡 `om_x100b62b9cc4f04a0cfb958a43ffae60` 的唯一创建回执仍是 2026-10-21 15:20:08 UTC，09:25:58 UTC 有新更新回执，飞书读回确认它仍是当前私聊中的任务总览交互卡。

09:25:32 UTC，ARBURG 的一条“已启动”状态继续写入内部历史；随后查询当前私聊自 09:25:14 UTC 起的消息，未发现新增消息。说明实际进度事实仍被保留，旧的逐轮状态广播已经停止。

本次没有手改生产 Ticket、预算、批准范围或执行状态，没有暂停业务路线。本次没有重跑此前全部 29 套回归，也没有将 TaskRun completed 当作 Ticket 验收通过。
