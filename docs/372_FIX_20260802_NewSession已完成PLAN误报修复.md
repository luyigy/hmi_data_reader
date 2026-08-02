---
doc_type: FIX
doc_status: completed
next_action: none
---

# FIX · New Session 已完成 PLAN 误报

## 问题

Session 切换确认卡把已有终态 HANDOVER 的 `docs/276_PLAN_20260728_群初始化与房间讨论计划命令.md`
仍显示为未完成，导致运行和 delivery 均为零时仍产生错误风险提示。

## 根因

`findUnfinishedPlan` 以 `docs/...` 路径枚举 PLAN，却直接保存 HANDOVER 的 `plan` 字段。合同允许同目录
HANDOVER 使用 PLAN 文件名，因此 `276_PLAN_...md` 无法与 `docs/276_PLAN_...md` 匹配。

## 修复

将不含目录的 `plan` 引用按 HANDOVER 所在目录规范化后再比较；已带目录的引用保持不变。

## 验证

- `npm run test:new-session-rotation`
- `npx tsc --noEmit`
- `npx eslint src/lib/feishu-new-session.ts tests/new-session-rotation.test.ts`
- `npm run check:long-files`
- `git diff --check`

回归样本同时包含真正未完成 PLAN 和以 basename 引用的已完成 PLAN，确认卡只保留前者。
