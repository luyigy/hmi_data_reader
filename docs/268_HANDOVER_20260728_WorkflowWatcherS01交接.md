---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: 267_PLAN_20260728_工作流交接与长文件守卫验证.md
slice: S01
plan_progress: in_progress
---

# HANDOVER · Workflow watcher S01 交接

## 完成内容

- 在 `tests/workflow-watcher.test.ts` 增加本地、确定性的 runner 等待场景。
- 断言旧 Session 仍在运行时 watcher 原样保留 prior cursor；随后可启动时以同一 event key 重试并推进。
- 未修改 watcher 实现，未执行 S02/S03，未启动真实 Agent、发送飞书消息、重启服务或修改数据库。

## 验证

- `npm run test:workflow-watcher`
- `git diff --check`

## 后续边界

仅执行 S02：在 `tests/workflow-completion-gate.test.ts` 增加超长文件增长的 completion gate 回归测试；不得执行 S03 或任何真实外部操作。

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/268_HANDOVER_20260728_WorkflowWatcherS01交接.md`、
`docs/267_PLAN_20260728_工作流交接与长文件守卫验证.md`、
`docs/266_REPORT_20260728_长文件告警与Agent可见性调查.md` 和
`docs/workflow/workflow-contract.yaml`，只执行 S02：为 workflow completion gate 增加“已达阻断阈值文件增长即拒绝完成”的确定性回归测试。先阅读 completion gate 现有测试与 long-file baseline 语义；如需修改共享 symbol，先运行 GitNexus upstream impact。不得启动真实 Agent、发送飞书消息、重启服务、修改数据库或执行 S03。运行聚焦测试和 `git diff --check` 后提交，并创建只允许执行 S03 的 S02 HANDOVER；提交后停止。
<!-- WORKFLOW_PROMPT_END -->
