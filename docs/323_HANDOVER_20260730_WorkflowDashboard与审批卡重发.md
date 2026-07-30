---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: null
slice: null
plan_progress: complete
---

# HANDOVER · Workflow Dashboard 与审批卡重发

## 完成内容

- 新增 `/ap dashboard [job-id]` 与 `/ap job dashboard <job-id>`，默认展示
  `workflow-watcher` 的飞书状态卡。
- 卡片展示启停、运行阶段、pending 文档、cursor/HEAD、最近执行和错误，并按状态提供刷新、
  立即运行、停止、启停、重发审批卡或恢复修改任务。
- 新增 `/ap job resend workflow-watcher`：只允许等待审批状态使用；事务锁内先使旧审批卡过期，
  再提交一次 watcher 请求。退回修改仍使用现有 `retry`，不混用两种恢复路径。
- dashboard 卡片按钮复用现有命令权限检查；`run`、`retry`、`resend` 只入队，不阻塞飞书卡片回调。
- 停止和停用按钮带二次确认；`clear-pending` 和移动 cursor 仍只允许显式命令。
- revision 状态不再展示旧审批卡的 expires/message 字段，改为展示修改任务是否已投递。

## 验证结果

- `tests/feishu-job-command.test.ts`：通过。
- `tests/workflow-watcher.test.ts`：通过。
- `tests/feishu-runtime-recovery.test.ts`：通过。
- 修改文件定向 ESLint、`npm run check:long-files`、`git diff --check`：通过。
- `agent-platform-feishu.service` 已重启；用户已在 Feishu DM 看到 `/ap dashboard` 卡片。

## 当前边界

- 尚未逐项真人点击立即运行、重发审批卡、恢复修改、启停和停止按钮。
- 未操作 HMI-Reader 的 pending、cursor 或审批状态，未启动 workflow watcher，也未发送测试审批卡。
- 全仓 TypeScript 检查仍被工作区既有的 `tests/workflow-watcher.test.ts` 类型错误阻断；本次目标文件
  未新增类型错误。
- 工作区还有 ACPX、Live Room、Feishu relay 等其他未提交修改，不属于本次提交。

## 关键入口

- `src/lib/feishu-scheduled-jobs.ts`
- `src/lib/feishu-command-parser.ts`
- `src/lib/feishu-long-connection.ts`
- `src/lib/feishu-help.ts`
- `tests/feishu-job-command.test.ts`
