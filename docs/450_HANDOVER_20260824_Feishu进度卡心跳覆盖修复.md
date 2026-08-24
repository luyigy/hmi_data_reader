---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/417_PLAN_20260813_三Harness进度流精准解析脱敏去重完整展示.md
slice: S06
plan_progress: complete
---

# HANDOVER · Feishu进度卡心跳覆盖修复

## 完成内容

- 修复 `FeishuProgressTracker.onSystemEvent`：心跳仍触发卡片刷新并写入系统信息，但不再把
  “当前阶段”改为等待，也不再用“心跳保活”覆盖最近一条有效思考或工具进展。
- 重复心跳仍会刷新卡片，以持续更新存活状态和已用时；系统信息列表继续去重，避免重复堆积。
- 聚焦回归覆盖“思考 → 心跳”和“工具 → 心跳”两条路径，以及重复心跳仍触发刷新。

## 影响范围

该修复位于所有 Live Room harness 共用的飞书进度追踪器，对 Codex、Kimi Code、Pi Agent、
Antigravity 及其他接入同一追踪器的成员生效，不改变 harness 解析、任务结果或调度行为。

## 验证

- `tests/feishu-progress-system-info.test.ts`：通过。
- `npx tsc --noEmit`：通过。
- `npm run check:long-files`：通过，无文件达到 1000 行阻断线。
- `git diff --check`：通过。

## 验收与遗留事项

- 提交后需重启 `agent-platform-feishu.service` 才会加载修复；本次未重启运行中服务。
- 建议在真实飞书 Live Room 触发一次长思考和一次工具调用，确认连续心跳期间卡片顶部仍保留最近有效进展，
  同时已用时持续更新。
- 工作区中的 `src/lib/real-agents/antigravity-agent.ts` 与 `tests/antigravity-agent.test.ts`
  是本次任务开始前已有的独立修改，不包含在本次提交中。
