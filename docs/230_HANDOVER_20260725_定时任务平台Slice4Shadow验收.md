---
doc_type: HANDOVER
doc_status: completed
plan: 224_PLAN_20260725_通用项目定时任务平台.md
slice: S04
plan_progress: in_progress
next_action: none
---

# 230_HANDOVER_20260725_定时任务平台Slice4Shadow验收

## 完成内容

- 新增平台 `workflow_watcher` handler，并注册到通用 Scheduled Job Runner。
- 仓库、ref、合同路径、branch space、旧 cursor 均来自项目配置。
- handler 固定读取 Git ref 中已提交的合同和文档，只识别目标 branch space 内最高
  编号的 PLAN/HANDOVER。
- 平台配置已启用该 job，但保持 `mode: shadow`；handler 额外硬拒绝 active，
  当前不会发送消息、创建审批、reset session 或投递 Prompt。
- 旧 watcher 状态已映射为数据库 cursor：
  `ebe9182bebcc8ede4691428459e27c3ad292771e`。

## 验收结果

- 14:00、14:10 两个平台自然周期均为 `shadow/succeeded`，
  `head=ebe9182… candidate=none`。
- 旧 Hermes watcher 对应周期同样在 `ebe9182…` 报无 PLAN/HANDOVER 变化，
  cursor 保持 idle。
- 只读历史回放与旧 watcher 一致：
  - PLAN `start_first_slice` → `plan_review`
  - HANDOVER `next_slice` → `workflow_ready`
  - HANDOVER `await_acceptance` → `terminal`
- event key 保持旧格式：`head:path:blob:action`。
- workflow watcher 专用测试、Runner、long-file detector、项目配置测试、
  TypeScript 和 diff check 通过。

## 当前边界

- Hermes `32b7e6b62a8c` 仍 active，未停止或修改。
- `legacy.automation_enabled` 未修改；平台 shadow 不消费 workflow。
- `/data1/code/cronJob` 的两处修改和未跟踪 FIX 文档仍原样存在。
- 当前 handler 只实现 shadow 观察面；active 模式明确失败，不能直接切 active。
- 本 HANDOVER 使用终态 `next_action: none`，因为合同不允许自动启动同一 Slice；
  继续 S04 active 阶段需人工开启下一 Session。

## 下一 Session

继续 `docs/224_PLAN_20260725_通用项目定时任务平台.md` 的 Slice 4 active 阶段。
先读取本 HANDOVER、workflow contract、平台 `workflow-watcher.ts` 和旧 watcher，
保留 `/data1/code/cronJob` 全部未提交改动。先运行 GitNexus upstream impact 并
报告风险；补齐完整合同校验、PLAN 审批、HANDOVER completion gate、reset 与 Prompt
投递的 active 行为及幂等测试。开始时平台和 Hermes 都保持现状；完成 active 链路
测试后再将平台单项目切 active，验证成功后才暂停 Hermes `32b7e6b62a8c`。不要开启
合同 `legacy.automation_enabled` 的自动消费开关。
