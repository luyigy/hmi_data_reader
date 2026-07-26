---
doc_type: PLAN
doc_status: ready
next_action: start_first_slice
plan_kind: phase
roadmap: 224_PLAN_20260725_通用项目定时任务平台.md
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · 审批后新 Session 与 Prompt 全链路验收

## 目标

用本 PLAN 验收完整真实链路：

1. watcher 为已提交的 PLAN 创建飞书文档并发送审批卡；
2. 真人点击“批准”后立即唤醒 watcher；
3. watcher 先清空当前会话，再启动下一 Session；
4. 下一 Session 收到并执行本 PLAN 标记区内的 Prompt，且全程只触发一次。

## S01：核对新 Session 与 Prompt 投递

在审批触发的下一 Session 中回报唯一标记，并核对 workflow cursor、审批终态及重复触发情况。
只做只读验收，不代替用户点击，不重发审批卡，不修改产品代码。

## 验收标准

- 飞书文档可打开，审批卡对应本 PLAN。
- 真人批准后，旧 Session 被清空且只启动一个新 Session。
- 新 Session 的第一条执行回复包含 `WORKFLOW_CHAIN_253_PROMPT_RECEIVED`。
- workflow cursor 与审批记录进入预期终态，无重复卡片、重复 Session 或重复 Prompt。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/253_PLAN_20260726_审批后新Session与Prompt全链路验收.md` 的 S01。你必须先在
回复第一行原样输出 `WORKFLOW_CHAIN_253_PROMPT_RECEIVED`，以证明新 Session 已收到本
Prompt；随后只读核对当前 Session 已由审批动作新建、workflow cursor 与审批记录已进入
预期终态，并确认没有重复卡片、重复 Session 或重复 Prompt。不得代替用户点击、重发
审批卡或修改产品代码；将核对结果直接回复到当前任务室。本次验收归属
`docs/224_PLAN_20260725_通用项目定时任务平台.md`。
<!-- WORKFLOW_PROMPT_END -->
