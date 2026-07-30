---
doc_type: REPORT
doc_status: completed
next_action: none
---

# REPORT · Workflow 阻塞通知与 Agent 投递验收

## 结论

`workflow-watcher` 的安全阻塞与文档校验失败不再只写入运行状态。Active 模式下，
watcher 会向绑定飞书会话发送可操作提示，并将结构化修复任务投递给 Coding Agent。
同一错误只通知、投递一次；错误内容变化后会重新处理。

2026-07-30 09:28:54 +08:00 重启 `agent-platform-scheduled-jobs.service` 后，
操作人已在 Live Room 确认消息成功投递给 Agent，运行验收通过。

## 修复范围

- Git ref 历史改写：提示原因、watcher 游标、目标 HEAD 和建议动作，并请求 Agent 分析。
- watcher 游标早于 workflow contract cutoff：采用同一阻塞反馈与 Agent 投递机制。
- PLAN/HANDOVER 校验失败：保留“不触发后续 Workflow 动作”的门禁，同时投递文档修复任务。
- 幂等键包含游标、HEAD 与错误原因；同一阻塞不会重复发送或启动 Agent。

## 安全边界

- 不自动移动 watcher 游标。
- 不改写 Git 历史。
- 文档校验失败时，Agent 只修订并提交文档，不执行后续 Workflow 动作。
- `shadow` 模式不产生飞书通知或 Agent 投递副作用。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run check:long-files` | 通过；无文件达到 1000 行阻断阈值 |
| `npm run test:workflow-watcher` | 通过；active/idempotency checks passed |
| `npx tsc --noEmit` | 通过 |
| Scheduled Jobs 服务 | 已重启并持续运行 |
| Live Room 运行验收 | 操作人确认消息已投递给 Agent |

## 变更文件

- `src/lib/scheduled-jobs/workflow-watcher.ts`
- `tests/workflow-watcher.test.ts`
- `docs/317_REPORT_20260730_Workflow阻塞通知与Agent投递验收.md`

本报告为验收记录，不触发 PLAN/HANDOVER workflow 自动化。
