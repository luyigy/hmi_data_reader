---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: 261_PLAN_20260727_Workflow自动化与群路由可靠性修复.md
slice: S01
plan_progress: in_progress
---

# HANDOVER · Workflow 自动纠错闭环 S01 交接

## 完成内容

- phase PLAN 未声明 `roadmap` 时，HANDOVER 不再产生空引用误报；声明后仍校验 Prompt 引用。
- watcher Prompt 和 validator 错误不再假设目标仓库存在 `npm run workflow:validate`。
- workflow completion 校验失败会续接同一个本地 Coding Agent session，要求只修订并提交
  失败的 PLAN/HANDOVER，再使用 TaskRun 开始时的原始 baseline 重新校验。
- 自动纠错最多两次；规范化错误指纹连续不变时立即熔断。
- 未提交 workflow 文档、不可续接 session、非 validator 错误和普通非 workflow TaskRun
  均保持原有失败或关闭语义。

## 验证

- `npm run test:workflow-validator`
- `npm run test:workflow-watcher`
- `npm run test:workflow-completion-gate`
- `npx tsc --noEmit`
- 相关文件 ESLint
- `git diff --check`
- GitNexus `detect_changes`

## 风险边界

`executeParticipant` upstream impact 为 CRITICAL，completion gate 与 validator 为 HIGH。
纠错入口继续受 `workflowCompletionGate === true` 和 `platform_local` 双重限制，未新增数据库
状态、目标仓库脚手架或普通 TaskRun 行为。

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/262_HANDOVER_20260727_Workflow自动纠错闭环S01交接.md`、
`docs/261_PLAN_20260727_Workflow自动化与群路由可靠性修复.md`、
`docs/224_PLAN_20260725_通用项目定时任务平台.md` 和
`docs/workflow/workflow-contract.yaml`，只执行 S02：修复群绑定、出站路由与 workdir
语义。先追踪 LiveRoom binding 入站、所有出站消息和任务 workdir 解析调用链，并对将修改
的 symbol 运行 GitNexus upstream impact。确保双群场景确定性回复原始入站群，明确 room、
绑定群、授权根目录和实际 workdir；不得执行 S03 或 S04，不得重启服务或修改
workflow-test。完成聚焦测试、TypeScript、相关 ESLint、`git diff --check` 和 GitNexus
`detect_changes` 后提交，并创建只允许执行 S03 的 S02 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
