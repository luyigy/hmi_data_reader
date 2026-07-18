# 206_HANDOVER_20260718_LiveRoom交接可见性修复

## 任务类型
bugfix / test / docs

## 所属主线
支线任务：Live Room Agent 协作；房间成员间交接不可见，必须立即修。

## 为什么做
在 `mold-data-webpage-tool` 项目的 Live Room 中，用户要求 Codex 把测试任务交给房间成员 Claude，但消息界面没有显示 `Codex -> Claude` 的定向交接。

数据库记录确认 Codex 实际创建了 `/root/claude_tester_retry` 内部子 Agent，而不是向 Live Room 中的 Claude 成员发送消息。最终回复虽然提到 Claude，却被记录为 `deliveryIntent: broadcast`、`visibility: room`，因此前端按既有规则不显示箭头，也没有触发房间 Claude 回复。

根因是 Live Room 定向协议只随首次任务描述发送；恢复 Codex/Claude 长会话时，runner 只传递最新用户消息，没有重新注入协议。长会话中的 Agent 因而可能使用 harness 内部的 `spawn_agent` / `send_message`，绕过房间级 `$member` 交接。

## 修改内容

- 新增 `src/lib/live-room-protocol.ts`，集中保存既有 Live Room 控制与定向交接提示。
- 明确房间成员不是内部子 Agent；匹配到可回复成员时必须使用 `$member`，不得用私有子 Agent 代替。
- 修改 `src/lib/live-room-delivery.ts`：恢复已有 harness session 时，把当前成员列表和定向协议与最新用户消息一起传入。
- 新增 `tests/live-room-directed-protocol.test.ts`，验证协议禁止内部委派、保留目标别名，并在 continuation 中重新注入。
- 未修改数据库结构、前端箭头渲染或 Live Room 消息模型。

## 验证结果

- `npx ts-node --compiler-options '{"module":"commonjs"}' tests/live-room-directed-protocol.test.ts`：通过。
- `npx --offline tsc --noEmit --pretty false`：通过。
- `git diff --check`：通过。
- `agent-platform-dev.service` 与 `agent-platform-feishu.service`：均为 `active`。
- 用户从真实 Live Room 入口复测，确认 Agent 间交接消息和执行均已成功。

## 对主线的影响

恢复了长会话中房间成员交接的可见性和正确路由。内部子 Agent 仍可用于普通并行工作，但不能代替用户明确指定的 Live Room 成员。

## 下一步建议

返回当前项目主线。若以后新增其他 harness，只需遵守同一 `$member` 协议，无需增加新的消息类型或前端分支。
