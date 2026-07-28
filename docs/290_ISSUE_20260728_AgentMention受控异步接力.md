---
doc_type: ISSUE
doc_status: draft
next_action: none
---

# ISSUE · Agent Mention 受控异步接力

## 状态说明

本文是非自动化问题记录，不是可执行 PLAN。workflow watcher 只自动处理 PLAN 和 HANDOVER，因此本文
不会发送新的审批卡、启动 Agent、移动当前 PLAN 288 的审批状态或执行任何 Slice。

## 背景

Live Room 曾允许 Agent 在回复中使用 `$member` 或 `@member` 自动调度下一位 Agent。旧实现会在当前
Agent 的调用栈中同步等待被 mention 的 Agent；当 B 再 mention 回仍未释放执行锁的 A 时，会形成：

```text
A 等待 B
  → B 等待新的 A
    → 新的 A 等待原 A 释放
```

提交 `0fc6214` 先采用止血语义：Agent 仍可输出 `$member` 或 `@member`，但它们只作为房间可见引用，
不再自动调度。这解除了同步回环死锁，却损失了 Agent 主动交接工作的能力，不应视为最终方案。

## 目标

恢复 Agent 间明确、可观察、可停止的自动接力，同时保证：

- 当前 Agent 先完整结束并释放成员执行锁，再启动下一位 Agent。
- mention 不形成嵌套等待或递归调用栈。
- 每次接力都有持久化状态，可在房间和任务运行记录中追踪。
- 接力次数有明确上限，循环或超限时停止并通知房间。
- `/ap plan` 继续使用固定顺序和主持人总结，不被自由 mention 扰乱。
- mention 不能扩大 Session 的权限上限，也不能绕过 workspace 边界。

## 建议的最小语义

- `$member`：请求在当前回复结束后向该成员进行一次受控 handoff。
- `@member`：仅用于房间可见引用，不触发调度。
- 一条 Agent 回复最多选择一个 handoff 目标；目标不唯一或不存在时只提示错误。
- handoff 复用现有 Live Room message、delivery、成员队列和 TaskRun，不新增第二套通用工作流引擎。
- 当前 delivery 先进入终态，调度器再原子领取后续 delivery；当前执行路径不等待后续 Agent 返回。
- 同一根消息的 handoff 使用有限轮次预算。具体预算值和唯一规则源在后续 PLAN 中确定，不散落硬编码。
- 达到轮次上限、目标离线、成员被停止或检测到无法继续的循环时，后续 delivery 进入明确终态并发送系统
  提示，不静默丢失，也不新建 Session 猜测恢复。

## 建议执行时序

```text
Agent A 完成回复并输出 $B
  → 保存 A 的回复和 handoff 意图
  → A 的 TaskRun / delivery 完整结束并释放队列
  → 调度器原子领取发给 B 的 delivery
  → B 在自己的现有 Session continuation 中执行
  → B 完成后可在剩余预算内请求下一次 handoff
```

核心约束是“先结束，再调度”，而不是把原来的同步递归简单改成未等待的 Promise。

## 与主持式流程的关系

- 普通 Live Room 对话可以使用 `$member` 受控接力。
- 用户显式定向消息和 `/ap chat --from-member --to-member` 保持现有语义。
- `/ap plan`、PLAN revision 和 `/run` 继续由结构化 orchestrator 决定成员顺序；Agent 在这些阶段输出的
  `$member` 只展示，不改变既定流程。
- 是否允许其他结构化 Workflow 开启 handoff，应由调用方显式声明，不能由输出文本自行突破。

## 验收要求

后续 PLAN 至少应覆盖：

1. A mention B 后，A 先结束，B 才开始；两者不存在嵌套等待。
2. A → B → A 不死锁，并受轮次预算限制。
3. 并发 watcher 或重复事件不能为同一 handoff 创建两个有效 delivery。
4. 停止、超时、Session 重置和成员离线时，待接力状态可终止且原因可见。
5. `$member` 能触发普通房间接力，`@member` 只展示。
6. `/ap plan` 和 PLAN revision 的固定成员顺序不受输出 mention 影响。
7. handoff 复用原 Session continuation，权限快照不被扩大。
8. 网页 Live Room 与飞书 Live Room 行为一致，并有聚焦回归测试。

## 转为可执行 PLAN 的条件

只有满足以下条件后，才基于本文另建并提交 `ready / start_first_slice` 的 PLAN：

- 当前 PLAN 288 已离开会吞掉其他候选文档的审批 pending 状态，并确认不会与其 HANDOVER 抢占 watcher。
- 明确 handoff 轮次预算、终止状态以及 `$member`、`@member` 的最终产品语义。
- 通过影响分析确认现有 delivery 队列足以承载，不先引入新的数据库状态机。
- 明确真实飞书测试房间、停止方式和失败后的恢复步骤。

在这些条件满足前，本文保持 `draft / none`，不参与自动化。
