---
doc_type: HANDOVER
doc_status: in_progress
next_action: next_slice
plan: docs/326_PLAN_20260730_Antigravity与Kimi真实上下文水位及账户Quota.md
slice: S02
plan_progress: in_progress
---

# HANDOVER · Antigravity 与 Kimi 真实 Quota S02 水位接入交接

## 完成内容

- Kimi Code 成功 turn 返回 Session id 后，从对应 `wire.jsonl` 投影当前 context fill，并按 Session
  实际 model alias 读取 `config.toml` 中的正整数 `max_context_size`。
- 清洗后的 Kimi snapshot 写入同一 `TaskRunParticipant.controlMetadata`，只包含 source、采集时间、
  Session id、model alias、used tokens、context window 和 wire protocol version；不保存原始事件、
  prompt、账户 quota 或凭证。
- Kimi snapshot 复用 Codex 的 15 分钟新鲜度与 Session 匹配语义；旧采集结果不得覆盖新结果，
  同 Session 的新 snapshot 可因 compaction 降低 used tokens。缺文件、损坏数据、model 不匹配、
  非正数窗口、过期、Session 不匹配和遥测持久化失败均 fail closed，不改变成功 turn 的结果。
- Live Room 水位改为 `provider | unknown | not_applicable`：
  - 只有新鲜且 Session 匹配的 Codex/Kimi provider snapshot 显示 percentage、used tokens/context
    window，并驱动 60%/85% Session 建议；
  - provider 不可验证时 percentage 为 `null`，显示“暂无 provider 上下文遥测”；
  - Platform Local Antigravity 固定显示“每轮新 conversation”，不显示百分比或 reset 建议。
- message/event/transcript 继续作为独立 Platform 代理信号展示，但不再换算 context percentage，也不
  生成“立即换 Session”建议。Web 与飞书成员状态继续复用同一 serializer。

## 边界与兼容性

- 没有新增 Prisma schema、migration、事件总线或通用 provider 抽象。
- 没有实现或查询 Kimi/Antigravity account quota；该范围仍属于 S03。
- 没有调用真实 Kimi/Antigravity 模型、发送飞书消息、重启服务或修改生产数据。
- `src/lib/acpx/prompt.ts`、`src/lib/acpx/runner-participant.ts`、
  `src/lib/live-room-members.ts` 和 `tests/context-watermark-warning.test.ts` 的开工前用户 quota
  改动已作为本 Slice 基线保留并接续；其他用户未提交文件未清理、覆盖或纳入提交。

## 验证

- Kimi wire parser、Kimi telemetry、Kimi agent、Kimi integration：通过。
- context warning、三态展示、Codex telemetry、Live Room workflow：通过。
- 相关 ESLint：通过。
- `npm run check:long-files`：通过，无 1000 行阻断文件。
- `git diff --check`：通过。
- `npx tsc --noEmit`：本 Slice 无新增类型错误；全仓仍被开工前已有的
  `tests/workflow-watcher.test.ts:711` 联合类型 `blocker` 访问错误阻断。
- GitNexus staged `detect_changes`：见本 HANDOVER 所在提交前的检查记录。

## 下一步边界

S03 只实现管理员账户 quota 与综合验收。必须继续保持 context 与 account quota 两条链路隔离；真实
quota smoke 仍需用户再次明确授权。不得以 TUI scraping、长期凭证复制或 Room 计数作为降级方案。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/326_PLAN_20260730_Antigravity与Kimi真实上下文水位及账户Quota.md` 的 S03。先读取目标 HEAD
的 workflow contract、本 PLAN 和
`docs/328_HANDOVER_20260730_Antigravity与Kimi真实QuotaS02水位接入交接.md`，确认并保护用户未提交改动，
运行 `npm run check:long-files`。只实现管理员账户 quota 与综合验收：Kimi 仅复用 S01 已验证的 managed
`/usages` 协议、当前认证边界和短时缓存；非 managed provider、超时、权限不足或协议异常返回
`unknown`。Antigravity 继续遵守 S01 停止门禁，在没有稳定受支持的 headless 协议时保持 `unknown`，
不得解析 TUI、私有缓存或复制长期凭证。扩展既有管理员 `/ap status --quota`，必须在任何数据库/provider
quota 查询前拒绝非管理员，普通 Room payload、Session metadata 和 context warning 不得包含或消费账户
quota。修改每个现有 symbol 前运行 GitNexus upstream impact，HIGH/CRITICAL 先报告；完成权限隔离、账户
边界、缓存过期、失败降级和相关回归测试，以及 TypeScript、ESLint、long-file guard、`git diff --check`
和 GitNexus `detect_changes` 后提交并创建终态 HANDOVER。未经用户另行明确授权，不调用真实模型、不执行
真实 quota smoke、不重启服务、不发送飞书消息或修改生产数据。
<!-- WORKFLOW_PROMPT_END -->
