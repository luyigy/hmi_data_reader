---
doc_type: HANDOVER
doc_status: in_progress
next_action: next_slice
plan: docs/326_PLAN_20260730_Antigravity与Kimi真实上下文水位及账户Quota.md
slice: S01
plan_progress: in_progress
---

# HANDOVER · Antigravity 与 Kimi 真实 Quota S01 协议取证交接

## 完成内容

- 新增 `src/lib/real-agents/kimi-code-context.ts`，按 Kimi 官方 context projector 语义解析
  Session `wire.jsonl`：
  - 最后一个非零 `context.append_loop_event / step.end / usage` 是当前 context fill；
  - `context.update_token_count`、`context.clear` 和 `context.apply_compaction` 覆盖当前值；
  - `usage.record` 是消费累计，不参与当前 context fill；
  - 保留 model alias 与 wire protocol version，未知事件忽略，损坏 JSON 或关键 token 字段缺失时
    fail closed。
- 新增 `tests/kimi-code-context.test.ts`，覆盖跨 chunk NDJSON、protocol 1.1/1.4、未知事件、
  `usage.record` 误用防护、零 usage、乱序时间、token count 更新、clear、compaction 和关键字段缺失。
- 没有修改现有 Kimi executor、Harness、Live Room serializer 或 prompt warning；parser 尚未接入生产
  执行路径，留给 S02。

## 协议结论

### Kimi Code 0.30.0

- 安装版 `stream-json` stdout 仍只提供 assistant/tool/meta/session resume，不直接提供
  `contextTokens`。
- 本机真实 wire 的 `usage.record` 使用 `usageScope: "turn"`；它描述调用消费，不是 Session 当前
  context。
- 安装版自带只读 `kimi vis` 与本 Slice 的最小投影结果一致：
  - 单轮、1 次工具调用 Session：`35,184` tokens；
  - 16 轮、43 次工具调用/结果 Session：`101,900` tokens；
  - 官方 compaction fixture：`tokensAfter = 30`。
- 当前本机 `kimi-code/k3` 的 `max_context_size` 为 `1,048,576`；S02 必须按实际 Session model alias
  读取对应正整数上限，缺失或不匹配时返回 `unknown`，不得使用默认估算。
- 官方依据：
  - `https://github.com/MoonshotAI/kimi-code`，取证 commit
    `d8f455d6942280cce2c8a93795515494d4b9e231`；
  - `apps/vis/server/src/lib/context-projector.ts` 明确区分 live context fill 与累计 usage；
  - `packages/node-sdk/src/session.ts`、`packages/node-sdk/src/rpc.ts` 提供
    `Session.getStatus()` / `getUsage()`；
  - `packages/oauth/src/managed-usage.ts` 定义 managed `/usages`，该账户 quota 留到 S03。

### Antigravity CLI 1.1.8

- 官方 CLI 支持 `--continue` / `--conversation`，但当前 Platform Adapter 每轮只执行 `agy -p`，
  不传 continuation，因此当前成员没有跨 turn conversation context。
- S02 对 Antigravity 必须返回 `not_applicable`，不得把单次 run usage、Room 消息数、事件数或
  transcript 字符数生成 Session context 百分比。
- 官方 `/usage` / `/quota` 会刷新后台额度，但只打开交互式 TUI panel；未发现稳定、受支持的
  headless quota 输出。本计划按停止门禁将 Antigravity account quota 保持 `unknown`，不解析 TUI
  或私有缓存。

## 验证

- `tests/kimi-code-context.test.ts`：通过。
- 本机两个真实 Kimi Session 与安装版官方 `kimi vis` 字段级对照：通过。
- Kimi 官方 compaction fixture 与安装版 `kimi vis` 对照：通过。
- parser 对上述两个真实 Session 和官方 compaction fixture 的再次读取断言：通过。
- 新增文件 ESLint：通过。
- `npm run check:long-files`：通过，无 1000 行阻断文件。
- `git diff --check`：通过。
- `npx tsc --noEmit`：新增文件类型错误已清零；全仓仍因开工前已有的
  `tests/workflow-watcher.test.ts:711` 对联合类型读取 `blocker` 而失败，本 Slice 未修改该文件。
- GitNexus `detect_changes(scope: staged)`：LOW，2 个新增文件，未影响已索引 symbol 或执行流。

## Git 与工作区

- PLAN 激活：`798d1ad`。
- PLAN 终态交接路径修正：`f45b2d7`。
- Kimi wire parser 与测试：`9385263`。
- 未调用真实 Kimi/Antigravity 模型、未查询真实账户 quota、未发送飞书消息、未重启服务、未修改
  数据库或生产数据。
- 开工前已有的源码、测试、`docs/DRAFT_20260730_quota.md`、`.codex-tmp/` 等未提交改动均未覆盖、
  清理或纳入本 Slice。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/326_PLAN_20260730_Antigravity与Kimi真实上下文水位及账户Quota.md` 的 S02。先读取目标 HEAD
的 workflow contract、本 PLAN 和
`docs/327_HANDOVER_20260730_Antigravity与Kimi真实QuotaS01协议取证交接.md`，确认并保护开工前用户未提交
改动，运行 `npm run check:long-files`。只把 S01 已验证的 Kimi wire context parser 接入成功 turn 后的
同 Session metadata 与既有 Live Room/prompt warning；按实际 model alias 解析正整数 context window，
缺失、损坏、过期、Session 不匹配或失败 turn 一律返回 `unknown`。Antigravity 在当前 Adapter 不续接时
固定为 `not_applicable`，不得用 run usage、消息数、事件数或 transcript 生成 context percentage。复用
现有 `controlMetadata`、Codex freshness/Session/乱序保护和统一 serializer，不新增数据库、事件总线、
通用 provider 抽象或账户 quota。修改每个现有 symbol 前运行 GitNexus upstream impact，HIGH/CRITICAL
先报告；完成聚焦测试、相关回归、ESLint、TypeScript、long-file guard、`git diff --check` 和 GitNexus
`detect_changes` 后提交并创建 S02 HANDOVER。不得自动进入 S03；未经用户另行明确授权，不调用真实模型、
查询真实账户 quota、重启服务、发送飞书消息或修改生产数据。
<!-- WORKFLOW_PROMPT_END -->
