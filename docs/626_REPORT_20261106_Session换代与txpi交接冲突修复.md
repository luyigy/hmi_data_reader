# Session 换代与 txpi 交接冲突修复

## 结论与范围

用户在 Feishu DM 08a216 要求先解决机台数据采集群的 Session 换代与 txpi 交接冲突，并确认 txpi 已无活动。源码修复提交为 `500b552`，基线 `a779b27`，在隔离 worktree `agent-platform-rotation-fix` 完成后 fast-forward 合入 `oss-prep`。

自动 workflow 换代现在等待当前 TaskRun、回复投递和交接待办结束；首次尝试、失败后的 `rotation_pending` 重试、旧确认状态恢复遵守同一规则。实际重置在 Session 锁内再次检查活动，发现活动返回等待，保留 dispatch 供调度重试。自动换代不调用 stop、取消队列或历史 PID 兜底；手动 `/new-session` 仍保留原有停止行为。

本报告不表示沙箱问题解决。下次讨论沙箱仍先读 [624 卡片修复与沙箱未决问题交接](624_REPORT_20261103_卡片修复与沙箱未决问题交接.md)，并参考 [625 凭据失效与重复通知修复](625_REPORT_20261106_Workflow凭据失效与重复通知修复.md)。本次没有改凭据、沙箱挂载或 TaskGraph 权限合同。

## 现场证据

目标群：`oc_bb599d4608ff895a5dfae3d1fb49107a`。房间 `cmu6kcl5m000110i3hrxwzo22`，sourceTask `cmu6kco8a000b10i3emlny51u`，job 为 `tb-feishu-alarm/workflow-watcher`。远程 Pi Agent 的房间昵称是 txpi，节点 desktop-78hk9dd-b2ea3685。

以下故障时间均为 2026-11-06 UTC（北京时间加八小时）：

- Codex S01 TaskRun `cmw4che2m0uit994kqza2pgxo` 在 02:24:20.918 完成。
- task_run_completed watcher 在 02:24:21.003 被唤醒，02:24:22.048 报“旧 Agent 运行未能实际终止”。
- Codex 投递 `cmw4chdc40uif994kckf4o1jr` 到 02:24:22.279 才结束；随后 txpi 投递 `cmw4cpnwe0vf7994kdqqbvddu` 在 02:24:22.334 创建，远程运行 `cmw4cpook0vfr994kwfz146uq` 于 02:24:23.347 启动。
- watcher 后续重试时 txpi 仍在运行。远程执行没有可供本机 PID 兜底停止的进程；独立 scheduler 也不能读取飞书进程内的运行注册表。

修复前重新读现场时，房间已无 pending/running/waiting_for_input TaskRun、无 pending/running 投递；041、042 HANDOVER 对应 dispatch 都已 completed，watcher lastError=null。最后一次合入前核对 lastSuccessAt=03:01:01.193Z。因此旧冲突已随任务完成自然重试恢复，本次修的是复发条件，没有重放已完成 Slice，也没有改 cursor、pending、审批结果或业务仓。

## 根因与改动

1. `feishu-workflow.ts` 原来只在 prepared 检查 running TaskRun。TaskRun 完成后回复仍可能在收尾，pending 交接、waiting_for_input 和 rotation_pending 重试都漏检。新增 `live-room-idle.ts`，以 sourceTask 活动运行和整个房间活动投递共同判断是否忙。
2. `feishu-new-session.ts` 为自动调用增加内部 waitForIdle 策略，在既有 Session 重置锁内复查；繁忙返回等待标记，由 watcher 转成 false，沿用 waiting_previous_completion。该策略不从聊天命令参数推断，手动调用默认行为不变。
3. `live-room-delivery-processing.ts` 原来在发布 assistant 消息前就把投递标为 delivered，handoff 又等到 setImmediate 才创建待办，留下可被误读为空闲的间隙。现保持 running，发布回复并用现有事务提交 handoff claim/目标 pending 投递后才确认源投递完成。普通回复也等消息发布后才完成；条件更新不覆盖已取消/失败的投递。
4. `live-room-delivery.ts` 使用已经持久化的 handoff claim，仍在当前成员队列释放后异步排入下一位，不重复扣 handoff 预算。

保留现有 Slice 边界对可轮换成员的范围，没有改为按角色选择重置成员。房间任一成员有活动时，自动换代整体等待。此次不把进程内注册表改造成跨进程控制通道，也不提供所有任务入口与重置之间的统一 admission fence；那些是独立的并发治理问题。异常退出留下的真实残留 pending/running 记录仍需按现有运行恢复机制核查，不因本补丁自动删除。

## 验证

修复前两个行为测试确定失败：

- workflow-dispatch-recovery：prepared 下存在 pending 投递仍启动换代，实际 true、预期 false。
- live-room-delivery-completion：assistant 消息发布时源投递已 delivered，且交接待办尚未持久化。

修复后通过：

- `tests/workflow-dispatch-recovery.test.ts`：首次/重试/旧状态恢复；pending/running 投递，pending/running/waiting_for_input 运行；锁内发现新活动后等待、空闲重试；故障检查点与终态不重放。
- `tests/live-room-delivery-completion.test.ts`：真实处理函数执行到回复发布及 handoff claim 时仍 running；返回前已持久化下一位 pending；普通回复、发布失败保持正确终态。
- `npm run test:new-session-rotation`：自动等待不 stop，空闲自动重置也不触发 PID 兜底；完成重放幂等；原手动停止、权限与故障恢复通过。
- `npm run test:workflow-watcher`、`npm run test:workflow-session-rotation`。
- `tests/live-room-handoff.test.ts`、`tests/live-room-handoff-boundaries.test.ts`、`tests/live-room-steering.test.ts`。
- `npx tsc --noEmit --incremental false`、改动文件 ESLint、长文件守卫、`git diff --check`。

无单独 npm script 的测试使用：`TS_NODE_BASEURL=. TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' node -r ts-node/register/transpile-only -r tsconfig-paths/register <测试文件>`。

测试没有调用真实模型或向群发测试消息。GitNexus 检查提示这是共享 Session/投递生命周期变更，差分风险为 critical；人工复核直接调用路径，并覆盖手动重置、steering、handoff 和 watcher。行为测试的数据库/模型边界使用替身，未声称已用真实远程机台复现整条链路。

## 生效与后续现场验证

源码已合入运行目录。确认无 running ScheduledJobRun 后，直接重启 `agent-platform-scheduled-jobs.service`；没有创建临时 systemd 服务。

飞书主进程尚未重启，仍缓存旧的回复处理与 task-completed watcher 代码。按照用户之前“我来重启”的要求，用户在 hello 终端执行：

```bash
systemctl --user restart agent-platform-feishu.service
systemctl --user is-active agent-platform-feishu.service agent-platform-scheduled-jobs.service
```

两者均 active 后，下一次正常交接观察：Codex 完成但 txpi pending/running 时 watcher 应等待，不发停止失败；txpi 和全部回复完成后原事件重试换代并接续一次。无需重启 Windows txpi runner 来加载本次平台补丁。不要为测试重放已完成的 041/042 事件，不要猜测恢复 cursor。
