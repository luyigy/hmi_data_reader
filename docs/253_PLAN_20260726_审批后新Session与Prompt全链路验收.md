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

# PLAN · PLAN 自动触发与审批后新 Session 全链路验收

## 目标

修复“PLAN 提交后未触发自动化流程”的问题，并验收完整真实链路：

1. 已提交且符合合同的 PLAN 能被 watcher 自动识别；
2. watcher 为 PLAN 创建飞书文档并发送审批卡；
3. 真人点击“批准”后立即唤醒 watcher；
4. watcher 先清空当前会话，再启动下一 Session；
5. 下一 Session 收到并执行本 PLAN 标记区内的 Prompt，且全程只触发一次。

## S01：修复 PLAN 提交后未触发自动化

复现并定位已提交 PLAN 未被 watcher 自动识别、未创建飞书文档或未发送审批卡的原因。
修复根因并补最小回归测试，确认本 PLAN 的重新提交能自动进入待审批状态。

## S02：核对新 Session 与 Prompt 投递

在用户批准后启动的下一 Session 中回报唯一标记，并核对 workflow cursor、审批终态及重复触发情况。
不得代替用户点击或手工绕过自动化链路。

## S03：用真实常驻 Run 验收跨进程停止

提供一个由现有 systemd 常驻服务承载、且用户能从飞书命令启动的可等待 Run。禁止用临时
Node 进程、内部 handler 调用或直接写数据库制造 Run；启动回复必须给出 Run ID，并能核对
承载服务仍为 `active (running)`。

Run 进入 `running` 后停止所有 Agent 代操作，由用户亲自在同一飞书会话依次执行：

```text
/ap job status <job-id>
/ap job stop <job-id>
/ap job status <job-id>
```

只有用户实际收到 stop 成功，且最后一次 status 显示 `running: false`、对应 Run 持久化为
`failed + job cancelled by operator`，才算端到端验收通过。若现有命令无法创建这种 Run，
先补最小的受控测试入口；入口必须复用正式 scheduled-job 执行链路，并默认禁用或限定测试项目，
不得引入第二套 runner。

## 验收标准

- 飞书文档可打开，审批卡对应本 PLAN。
- PLAN 提交后无需手工唤醒或手工创建审批，即可进入待审批状态。
- 真人批准后，旧 Session 被清空且只启动一个新 Session。
- 新 Session 的第一条执行回复包含 `WORKFLOW_CHAIN_253_PROMPT_RECEIVED`。
- workflow cursor 与审批记录进入预期终态，无重复卡片、重复 Session 或重复 Prompt。
- 用户能通过飞书命令启动由常驻服务实际承载的可等待 Run，并亲自完成
  `status → stop → status`；临时进程或内部函数调用结果不计入验收。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/253_PLAN_20260726_审批后新Session与Prompt全链路验收.md` 的 S01：复现并
定位“符合合同的 PLAN 已提交，但 watcher 未自动创建飞书文档或发送审批卡”的根因，
完成最小修复和回归测试，并用真实提交验证自动流程已进入待审批状态。不要用手工唤醒、
手工创建文档、手工发卡或手工新建 Session 来替代自动链路；S01 验证通过后，等待用户
真人批准，再按 S02 验收新 Session 与 Prompt 投递。本次验收归属
`docs/224_PLAN_20260725_通用项目定时任务平台.md`。
<!-- WORKFLOW_PROMPT_END -->
