---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: null
slice: null
plan_progress: complete
---

# HANDOVER · Live Room Handoff 自循环修复

## 问题与根因

启用 Live Room handoff 后，注入给 Agent 的 turn protocol 要求普通回复必须输出一个
`$member`。这会诱导 Codex 在不需要协作时仍发起下一跳；同时候选列表包含当前成员自身，
进一步增加自我提及或成员间反复接力的概率。虽然根消息存在 handoff 次数上限，这仍会造成
用户可见的连续无效迭代。

## 修复

- 普通回复不再强制输出 `$member`；仅当当前请求确实需要另一位房间成员继续时才允许一次 handoff。
- 协议明确禁止 handoff 给自己。
- 构建可回复成员列表时按当前 Live Room member ID 排除执行中的成员，避免把自己展示为候选目标。
- 保留显式跨成员 handoff、单目标限制、预算、幂等 claim 和结构化 `/ap plan`、`/run` 行为。

## 修改范围

- `src/lib/live-room-protocol.ts`
- `src/lib/live-room-delivery-execution.ts`
- `tests/live-room-directed-protocol.test.ts`

工作区中既有 workflow watcher、completion gate、scheduled jobs 及其他未提交改动不属于本次修复，
未修改、清理或纳入提交。

## 验证

- `tests/live-room-directed-protocol.test.ts`：通过。
- `tests/live-room-handoff.test.ts`：通过。
- `npx tsc --noEmit`：通过。
- 修改文件定向 ESLint：通过。
- `npm run check:long-files`：通过，无文件达到 1000 行。
- `git diff --check`：通过。
- GitNexus upstream impact：`buildLiveRoomControlManual` 为 LOW；
  `runLiveRoomAcpxAttempt` 因位于共享 Live Room 投递链被评为 HIGH，本次仅修改 prompt 和候选展示，
  未修改 delivery、Session、数据库或外部接口。

## 部署与验收

- 本 HANDOVER 提交后重启 `agent-platform-feishu.service` 加载新代码。
- 由用户在真实 Live Room 验证：
  1. 普通 Codex 回复不再无条件输出 `$member`；
  2. Codex 不再把自己作为 handoff 目标；
  3. 明确要求另一成员继续时仍只产生一次有效 handoff；
  4. 对方完成后若无需更多协作，链路停止。
