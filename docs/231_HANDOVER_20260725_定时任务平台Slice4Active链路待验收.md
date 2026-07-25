---
doc_type: HANDOVER
doc_status: completed
plan: 224_PLAN_20260725_通用项目定时任务平台.md
slice: S04
plan_progress: in_progress
next_action: none
---

# 231_HANDOVER_20260725_定时任务平台Slice4Active链路待验收

## 完成内容

- 在既有 `workflow-watcher.ts` 内补齐合同校验、PLAN 审批、
  HANDOVER completion gate、terminal 通知、reset 确认和下一 Session Prompt。
- active 需要同时满足运行模式、`active_side_effects_enabled: true`、机器人身份和唯一
  审批人配置；当前项目仍为 shadow，配置中也没有 active 身份与副作用开关。
- pending、event key 和 Git cursor 写入既有 `ScheduledJobState.cursorJson`。
- 所有发送步骤使用 `event key + step` 派生的稳定 idempotency key；失败、进程重启和
  后续周期会重放相同请求键，不会创建第二个审批、reset、Prompt 或 terminal 通知。
- PLAN 的 approve、reject、revise 以及修订后重新审批语义已对齐旧 watcher。
- 仓库、ref、branch space、合同和飞书参数继续只从项目配置及目标 Git ref 读取。

## 验证结果

- active 隔离测试覆盖：成功、Prompt 失败后重试、cursor JSON 重启恢复、重复事件、
  terminal/no-op 和 active 门禁；测试使用临时仓库及假 `lark-cli`，未访问真实飞书。
- workflow watcher、Scheduled Job Runner、long-file detector、项目配置测试通过。
- `tsc --noEmit`、Prisma validate、19 项 migration status 和 `git diff --check` 通过。
- 平台 Scheduled Job Runner 为 active/running；重启加载本提交后，14:40 自然周期为
  `workflow-watcher shadow/succeeded`，cursor 保持 `ebe9182…` 且 candidate 为 none。
- Hermes `32b7e6b62a8c` 仍 active；14:36 自然周期同样在 `ebe9182…` no-op。

## 当前边界

- 未把平台项目切为 active，未发送真实 PLAN 审批、reset、Prompt 或 terminal 通知。
- 未停止或修改旧 Hermes watcher；真实 active 单项目切换仍需受控验收，切换期间不能
  让两套 watcher 同时产生副作用。
- 未修改 Runner、Prisma 模型、migration、发送接口或项目配置。
- `/data1/code/cronJob` 的两处修改和未跟踪 FIX 文档保持原样。
- 本 HANDOVER 使用 `next_action: none`，不会自动触发下一 Session。

## 后续验收

在独立测试群或明确批准的维护窗口，将项目配置补齐机器人身份及
`active_side_effects_enabled: true`，先暂停 Hermes，再把平台单项目切 active。依次
验证 PLAN approve/revise、HANDOVER `WORKFLOW_READY`、reset 确认、Prompt 投递和
重启恢复；全部通过后才正式停用 Hermes `32b7e6b62a8c`。若任一 active 步骤失败，
立即恢复平台 shadow 并保持 Hermes 为唯一正式 watcher。
