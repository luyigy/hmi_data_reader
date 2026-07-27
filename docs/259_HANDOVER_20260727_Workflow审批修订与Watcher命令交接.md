---
doc_type: HANDOVER
doc_status: paused
next_action: next_slice
plan: 253_PLAN_20260726_审批后新Session与Prompt全链路验收.md
slice: S01
plan_progress: in_progress
---

# HANDOVER · Workflow 审批修订与 Watcher 命令交接

## 当前状态

平台侧代码、数据库 migration 和一分钟 watcher 配置已完成，待用户重启
`agent-platform-feishu.service` 与 `agent-platform-scheduled-jobs.service` 后继续真实验收。
本交接不授权 Agent 代替用户重启服务或点击审批卡。

`workflow-test` 已提交 010 修改按钮测试 PLAN 和 011 双 Slice 问候测试 PLAN。010 已由用户
通过 `--clear-pending` 清除；011 因审批人点击“修改”而处于 `plan_review / revision`
pending。

## 已完成

- workflow watcher 在发现新 PLAN 的同一轮导入飞书文档并发送审批卡。
- 批准、拒绝和修改均通过卡片事件立即进入统一审批状态转换。
- 拒绝与修改都有持久群消息回执；重复或旧卡片操作不会重复推进。
- 修改意见可选：
  - 有意见时，Coding Agent 按反馈只修订并提交该 PLAN。
  - 无意见时，不启动 Codex；平台先发送固定询问，审批人回复后才投递 Coding Agent。
- 审批卡的修改意见输入框与修改按钮已放入飞书 `form` 容器，输入框为多行可选项。
- revision 不再依赖机器人向自身发送普通消息，而是复用
  `runWorkflowInBoundLiveRoom` 直接投递 Coding Agent；旧 `revision` cursor 会补投一次并
  写入 `revisionDispatched`，后续轮询保持幂等。
- 空反馈使用 `awaiting_revision_feedback` 状态；watcher 保存询问消息 ID，长连接只接受
  唯一审批人对该消息的回复，并在事务锁内转为 `revision_requested` 后立即唤醒 watcher。
- 同一路径 PLAN 修订并提交后，watcher 通过新 blob 识别变更、重新导入文档并再次发起审批；
  修改循环可重复，直至批准或拒绝。
- `/ap job cursor workflow-watcher` 展示 pending 路径、gate、action、review state、过期时间
  和卡片 message ID。
- `/ap job cursor workflow-watcher --clear-pending` 只清除 pending，保留 cursor 和 event
  key，适合测试或故障处置。
- `/ap job cursor workflow-watcher --latest` 会把 cursor 推进到当前 HEAD 并跳过全部旧提交；
  当前存在 011 时禁止用它清理 010。
- `/ap job schedule workflow-watcher --cron="* * * * *"` 可设置运行时周期，
  `--cron=default` 恢复项目配置。
- Prisma 已应用 migration
  `20260727193000_add_scheduled_job_schedule_override`；schema 当前已是最新。

## 验证结果

本轮及此前同一未提交变更集已实际通过：

- `npx prisma validate`
- `npx prisma generate`
- `npx prisma migrate status`
- `npm run test:workflow-watcher`
- `npm run test:scheduled-jobs`
- `tests/feishu-job-command.test.ts`
- `tests/project-config.test.ts`
- `npx tsc --noEmit`
- 相关文件 ESLint
- `git diff --check`

GitNexus 对 `applyWorkflowReviewDecision` 的 upstream impact 为 HIGH：3 个直接调用方，影响
卡片回调与 watcher 两条流程；已用统一转换测试覆盖。全工作区 `detect_changes` 为 CRITICAL，
其中包含本分支既有的 AGENTS、Feishu、新 Session、配置、调度和数据库变更；本次按用户明确
要求将当前工作区作为整体提交。

## 用户重启后继续

1. 011 已由旧实现启动 Codex，不能用于验证新的空反馈快路径；先按实际需要结束或清理该测试。
2. 使用新的 PLAN 审批卡留空修改意见并点击修改，确认平台立即发送询问，且此时没有新
   TaskRun/Codex 进程。
3. 审批人回复该询问，确认随后才出现 `PLAN_REVISE` 和 Coding Agent Run。
4. 等待 Agent 只修订并提交 PLAN，确认 watcher 重新生成审批卡。
5. 真人批准后核对只执行当前 Slice 并提交下一 Slice 的 HANDOVER；不得在
   同一 Session 执行 S02。

## 提交与运行边界

- 本文档所在提交包含提交前工作区的全部修改，不再区分此前用户改动与本轮改动。
- 服务尚未加载该提交；运行态验证必须在用户重启两个服务后进行。
- 本次不创建或修改真实审批，不代替用户执行卡片按钮。

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/259_HANDOVER_20260727_Workflow审批修订与Watcher命令交接.md`、
`docs/253_PLAN_20260726_审批后新Session与Prompt全链路验收.md` 和
`docs/224_PLAN_20260725_通用项目定时任务平台.md`，并遵循
`docs/workflow/workflow-contract.yaml`，继续 S02 真实验收。先确认用户已重启
`agent-platform-feishu.service` 与 `agent-platform-scheduled-jobs.service`，再用
`/ap job cursor workflow-watcher` 核对状态。011 已由旧实现启动 Codex，不用于验证新快
路径；使用新的 PLAN 审批卡留空修改意见并点击修改，确认平台立即发送询问且不创建
TaskRun。审批人回复该询问后，确认此时才出现 `PLAN_REVISE` 和 Coding Agent Run，并且
Agent 只修订并提交 PLAN，watcher 随后重新生成带多行修改意见输入框的审批卡。最后等待
用户真人批准，核对只执行当前 Slice 并提交下一 Slice 的可执行 HANDOVER；不得代替用户
点击按钮、不得在同一 Session 执行后续 Slice。
<!-- WORKFLOW_PROMPT_END -->
