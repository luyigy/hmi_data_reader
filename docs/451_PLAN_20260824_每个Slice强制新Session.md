---
doc_type: PLAN
doc_status: completed
next_action: await_acceptance
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · 每个Slice强制新Session

## 背景

Workflow 角色派发此前仅在会话上下文达到水位阈值时换代，导致低水位的新 Slice 继续复用旧
Session，Slice 之间的上下文无法可靠隔离。现有 event-key 换代状态机已经具备安全创建 fresh
Session、继承运行配置和崩溃恢复能力，无需新增水位算法或 Session API。

## S01：每个新 Slice 强制换代

### 范围

1. `roleWorkflow=true` 的新 Slice 派发跳过水位判断，直接复用现有换代状态机。
2. 非角色 workflow 的 PLAN 修订、同 Slice 重试和 completion-gate 纠错维持原会话策略。
3. 增加低水位仍换代的恢复测试，保留 event-key 幂等和崩溃恢复覆盖。

### 完成标准

- 新 Slice 在水位判断为 `reuse` 时仍创建 fresh Session。
- 同 Slice 内重试不重复换代，非 Slice 派发不改变既有行为。
- 聚焦回归、TypeScript、长文件守卫和 diff 检查通过。
