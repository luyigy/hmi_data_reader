# 208_HANDOVER_20260718_Codex定向与模型配置

## 任务类型

bugfix / feature

## 所属主线

临时插队；阻塞 Live Room 中 Codex 与 Claude 的可靠定向协作。

## 为什么做

Agent 使用平台规定的 `$member` 协议转交任务时，接收方仍会收到自己的 `$claude` 路由前缀，可能把消息原样转发给自己而不执行正文。

同时，Live Room 中启动的 Codex 只能继承全局 `~/.codex/config.toml`，无法按房间成员选择 model 和 thinking level。

## 修改内容

- `src/lib/live-room-protocol.ts`、`src/lib/live-room-delivery.ts`
  - 在送入目标 Agent 前统一移除开头的 `@member` 或 `$member` 路由前缀。
- `prisma/schema.prisma`、`prisma/migrations/20260718183000_add_live_room_member_codex_model/migration.sql`
  - 为 Live Room 成员持久化 `codexModel` 和 `codexReasoningEffort`。
- `src/lib/real-agents/codex-agent.ts`、ACPX/harness/remote SSH 链路
  - 新 run 与 resumed session 都向 Codex CLI 传递 `--model` 和 `model_reasoning_effort`。
  - Platform Local 与 Remote SSH Codex 使用相同行为。
- `src/components/live-room/LiveRoomWorkspace.tsx`
  - Codex 成员卡新增 model 输入和 thinking level 选择。
- `src/lib/feishu.ts`
  - 新增 `/ap codex-config --agent=<member> [--model=<model|inherit>] [--thinking=<level|inherit>]`。
- `src/lib/live-room-codex-settings.ts`
  - 集中校验 model 字符和 thinking level，空值表示继承全局 Codex 配置。

`src/components/live-room/LiveRoomWorkspace.tsx` 和 `src/lib/feishu.ts` 已超过 1000 行，本次仅做直接相关的窄范围修改；后续继续扩展成员配置时，可将成员设置面板和 Feishu 成员配置命令分别提取。

## 验证结果

- `npx ts-node --compiler-options '{"module":"commonjs"}' tests/live-room-directed-protocol.test.ts`：通过。
- `npx ts-node --compiler-options '{"module":"commonjs"}' tests/codex-member-settings.test.ts`：通过。
- `npx prisma migrate deploy`：迁移成功。
- `npx tsc --noEmit --pretty false`：通过。
- `git diff --check`：通过。
- `agent-platform-dev.service` 与 `agent-platform-feishu.service` 已重启并处于 `active`。
- Web 首页健康请求返回 HTTP 200，Feishu WebSocket client ready。

仍需在真实 Live Room 中手工验证一次指定 model/thinking 的新 run 和 continuation，并确认目标模型账户具备相应模型权限。

## 对主线的影响

修复 Agent-to-Agent 自转发问题，并让同一房间内不同 Codex 成员可独立选择模型和推理强度，不改变未配置成员继承全局 Codex 设置的行为。

## 下一步建议

在 Web UI 和 Feishu 各执行一次配置与对话验收；若模型不可用错误需要更友好提示，再从 Codex CLI 的现有错误事件补充展示，不预先增加模型目录同步。
