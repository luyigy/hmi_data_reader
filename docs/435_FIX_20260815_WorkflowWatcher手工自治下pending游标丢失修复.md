---
doc_type: FIX
doc_status: completed
next_action: none
---

# FIX · Workflow Watcher 手工自治下 pending 游标丢失修复

## 问题描述

`workflowWatcherHandler` 在 workflow 自治为 `manual` 时，对可执行动作（如
`next_slice`）的候选文档提前返回，且返回的游标是 `cursor: previous`——既不前移
`commit`、不记录 `eventKey`，也不持久化 `pending`。由此产生两个问题：

1. **完成回执重复投递**：由于游标未记录 `eventKey`/`commit`，每个扫描 tick 都把同一
   候选文档当作新事件重新走一遍检测路径，向飞书群重复发送「Workflow 完成回执」，
   manual 模式下轮询持续刷屏。
2. **`previous.pending` 分支不可达**：pending 从未写入游标，入口处
   `if (previous.pending)` 的续跑、Pending 超越检查（更高编号文档取代旧 pending）
   在 manual 模式下全部失效。

## 根因分析

`src/lib/scheduled-jobs/workflow-watcher.ts` 中原判断：

```ts
if (gate === 'execute' && !allows(document.action)) {
  return {
    summary: `head=${head} candidate=${candidate.filePath} gate=autonomy_manual advance=${document.action}`,
    cursor: previous,   // ← 丢弃了本次扫描的全部状态
  };
}
```

该判断位于 `pending` 对象构造之前，只能用 `previous` 兜底返回，导致 manual 模式下
watcher 无法把"已检测到待推进文档"这一事实固化到游标。

## 修复方案

将 manual 自治判断移动到 `pending`（`gate: 'workflow_ready'`）构造完成之后，并把
pending 一并写入游标：

```ts
if (!allows(pending.action)) {
  return {
    summary: `head=${head} candidate=${candidate.filePath} gate=autonomy_manual advance=${pending.action}`,
    cursor: carryQuarantine({ commit: head, eventKey, pending }),
  };
}
```

效果：

- 首次扫描发送一次完成回执，并在游标中记录 `commit`/`eventKey`/`pending`；
- 后续扫描命中 `duplicate` 或 `previous.pending` 分支，**不再重发回执**；
- manual 模式下 pending 可被更高编号文档超越，自动续跑逻辑恢复一致。

## 改动点

1. **`src/lib/scheduled-jobs/workflow-watcher.ts`**
   - 删除 `gate === 'execute' && !allows(document.action)` 的提前返回；
   - 在 `pending` 构造后新增 `!allows(pending.action)` 判断，返回携带 pending 的
     `carryQuarantine` 游标。
2. **`tests/workflow-watcher.test.ts`**
   - 新增 manual 模式回归断言：首次扫描 summary 匹配
     `gate=autonomy_manual advance=next_slice`，游标含 `commit=HEAD`、`eventKey`、
     `pending.gate='workflow_ready'`，完成回执计数 +1；
   - 以相同游标再次扫描，断言回执计数**不再增加**
     （manual polling after first scan must not resend the completion receipt）。

## 验证情况

- `npm run test:workflow-watcher`
  - 通过（active/idempotency checks passed；测试内含本次新增 manual 回归断言）。
- `npx tsc --noEmit`
  - TypeScript 类型检查通过。
- `npm run check:long-files`
  - 无 ≥1000 行阻断文件。
