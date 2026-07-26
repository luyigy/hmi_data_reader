---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: null
slice: hotfix
plan_progress: complete
---

# Feishu new-session 终止旧进程修复

## 问题与根因

`/ap new-session` 会轮换 Session，但旧 Codex 进程收到的是 `interrupt_now`（`SIGINT`）；
进程不退出时，数据库状态已重置而 OS 进程仍继续运行。

## 修复

- `interruptLiveRoomMemberReplies` 支持复用现有 `RunControlAction`，默认仍为
  `interrupt_now`，不改变普通“中断回复”行为。
- `/ap new-session` 显式传入 `stop_run`，通过现有进程注册表向旧 run 发送 `SIGKILL`，
  再轮换 Session。

## 验证

- `npx tsc --noEmit`：通过。
- Feishu 命令相关测试：通过。
- GitNexus 影响检查：共享中断入口初始风险为 CRITICAL；最终变更仅涉及预期的中断和
  new-session 流程，风险为 MEDIUM。

## 人工验收

在 Feishu DM 中运行 `/ap new-session`，确认：

1. 返回新 Session 已创建。
2. 旧 Codex 进程退出。
3. 新 Session 中的后续消息只产生一个 Codex 进程。

若旧进程仍存在，记录命令执行前后的 PID、run ID 和 runtime 日志；不要重复补 kill，
应继续检查 `stop_run` 从进程注册表到本地 runner 的投递链路。

## 修改文件

- `src/lib/live-room-interrupt.ts`
- `src/lib/feishu-new-session.ts`
- `docs/246_HANDOVER_20260726_FeishuNewSession终止旧进程修复.md`
