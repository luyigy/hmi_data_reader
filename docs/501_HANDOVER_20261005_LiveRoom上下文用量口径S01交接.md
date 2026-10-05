---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/500_PLAN_20261005_LiveRoom上下文用量口径修复.md
slice: S01
plan_progress: complete
---

# HANDOVER · LiveRoom上下文用量口径S01交接

## 本次改动

- 标准化用量增加 `totalTokens` 与默认窗口标记；缺少 provider 窗口时统一使用 1,000,000 tokens 作展示估算，并在脚注注明。读取旧 Codex 元数据时也保留历史总量。
- Codex 读取 provider 的会话总量；Pi 沿当前会话分支累加 assistant usage；Kimi Code 从 wire 的 `step.end` 累加；Antigravity 将同一 continuation 的各次运行输入与输出累加。缺少完整记录时不伪造历史总量。
- 房间脚注同时展示当前指标占窗口的百分比和历史消耗的“窗口当量”百分比，后者可超过 100%；预警阈值调整为 75% 提醒、85% 严重提醒，提示命令为 `/ap new-session`。
- 审核时发现 Antigravity 的 `usage.input_tokens` 是一次运行内多步累计量，不能当作最近一轮上下文。已将其标为“本次运行累计输入”，不以此计算实时水位或触发切会话预警。
- 调整直接测试，覆盖四类 harness、估算窗口、历史百分比、预警和 Antigravity 的累计量口径。

## 验证

- `npx tsc --noEmit` 通过。
- `normalized-context-usage`、`live-room-footnotes`、`harness-context-usage`、`kimi-code-runtime-state`、`pi-runtime-state`、`context-watermark-warning` 六项直接测试通过。
- `npm run check:long-files` 通过，当前没有达到 1000 行阻断阈值的文件；`git diff --check` 通过。
- 未做真实飞书房间端到端验收，最终显示值仍取决于运行时 provider 遥测是否可用。

## 口径与后续

历史总消耗除以窗口只表示资源消耗的窗口当量，不代表当前上下文剩余空间。Antigravity 目前只能确认运行累计量，不能从现有结果可靠还原最近一步的上下文占用。新会话可从本 HANDOVER 与 PLAN 继续核对线上脚注；若要提供 Antigravity 实时水位，先取得可信的逐步 provider 遥测和实际窗口。
