---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: 271_PLAN_20260728_工作流诊断与飞书操作导航.md
slice: S01
plan_progress: in_progress
---

# HANDOVER · Workflow Watcher 诊断 S01

## 完成内容

- 新增只读 `/ap job diagnose workflow-watcher`：输出 job 状态、cursor、目标 HEAD、祖先关系、pending、最近失败和按现有合同筛选的候选文档。
- 历史改写时明确提示：`--latest` 会跳过待处理提交，必须由人工确认恢复基准；诊断不写数据库、不移动 cursor、不清 pending、不发送飞书消息或启动 Agent。

## 验证

- `tests/feishu-job-command.test.ts`（含命令解析、诊断输出、cursor 祖先关系和候选选择）通过。
- `npx tsc --noEmit`、相关 ESLint、`git diff --check` 通过。

## 后续

仅继续 S02 的分组分页帮助；不得在同一 Session 执行 S03 或 S04，不重启服务，不修改 `workflow-test`。

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/271_PLAN_20260728_工作流诊断与飞书操作导航.md`、
`docs/272_HANDOVER_20260728_WorkflowWatcher诊断S01交接.md` 和
`docs/workflow/workflow-contract.yaml`，只执行 S02：实现 `/ap help [页码]` 与
`/ap help --page=<页码>` 的分组分页帮助及聚焦测试。复用现有命令能力和 parser，不新增第二套权限或动作注册表；不得执行 S03、S04，不重启服务，不修改 `workflow-test`。完成相关测试、TypeScript、相关 ESLint、`git diff --check` 和 GitNexus `detect_changes` 后提交，并创建只允许执行 S03 的 HANDOVER。
<!-- WORKFLOW_PROMPT_END -->
