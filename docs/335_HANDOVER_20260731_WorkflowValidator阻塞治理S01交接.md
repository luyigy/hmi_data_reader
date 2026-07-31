---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md
slice: S01
plan_progress: in_progress
---

# HANDOVER · Workflow Validator 阻塞治理 S01 交接

## 完成内容

- Validator 用 `WorkflowDocumentValidationError` 区分已证明的文档错误与 Git、依赖、合同读取等运行故障：
  文档错误 fail closed，运行故障不再伪装成文档错误。
- append-only reference hook 升级为 v2：继续阻止 ref 删除和非 fast-forward；对变更的 PLAN/HANDOVER
  使用受保护 ref 的旧合同批量校验。只有带明确文档错误标记的失败阻止提交，Validator 无法运行时告警并
  允许普通提交。
- watcher 对同一 `path + blob` 首次失败通知，复验仍失败时隔离并前移游标；新 blob 会重新校验。只有
  `WorkflowDocumentValidationError` 可进入该路径，运行故障原样交给 runner 重试，不会被错误隔离。
- completion gate 将当前 Run 新增的 dirty workflow 文档送入最多两次的原 Session 纠错；错误指纹不变
  立即停止。Validator 运行故障原样上抛，不再触发无意义纠错 Session。
- scheduled runner 启动时按项目安装 Git guard，一个仓库失败不会拖垮其他项目；活跃任务失败通知包含
  影响和下一步，并以既有 `ScheduledJobState.lastError` 去重相同连续失败。
- 更新 333 PLAN，将 Validator 可用性和 Workflow 状态/完成可见性提升为 S01/S02，并记录
  Antigravity 以 1M fallback 参与房间最大水位的最新决策。

## 验证结果

- `npm run test:workflow-validator`：通过。
- `npm run test:workflow-watcher`：通过。
- `npm run test:workflow-completion-gate`：通过。
- `npm run test:scheduled-jobs`：通过。
- `npm run test:git-history-guard`：通过。
- `npx tsc --noEmit`：通过。
- S01 修改文件定向 ESLint：通过。
- `npm run check:long-files`：通过，无 1000 行阻断文件。
- `git diff --check`：通过。
- 全仓库 `npm run lint`：未通过；失败均位于本 Slice 未修改的既有 agents、gateway、旧 UI 等文件，
  本 Slice 未扩大范围处理。

## 影响与边界

- GitNexus upstream impact：`executeScheduledJob` 为 HIGH（4 个直接调用、4 条流程），其修改仅限失败通知
  的内容与既有 `lastError` 去重，并由 runner 回归测试覆盖；其余修改符号均为 LOW。
- 未开始 S02，不新增 Workflow 状态机、数据库表、migration、自治模式或 Session rotation。
- 未重启服务，未发送真实飞书消息；通知测试使用 fake sender。
- 未提交 `.codex-tmp/`、`.playwright-mcp/`、草稿、Inbox、登录二维码等无关工作区文件。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/333_PLAN_20260731_Workflow三模式Session治理与计划审批执行.md` 的 S02：先读取目标 HEAD 的
`AGENTS.md`、`docs/workflow/workflow-contract.yaml`、本 PLAN、
`docs/335_HANDOVER_20260731_WorkflowValidator阻塞治理S01交接.md`，以及现有 workflow checkpoint、
watcher cursor、审批状态、ScheduledJobState、TaskSession、Feishu 命令和 Web Dashboard 实现。保护所有
开工前用户改动，运行 `npm run check:long-files`。只实现一个由现有事实源计算的只读
`WorkflowStatus` 投影，以及 `/ap workflow status`、Web/飞书展示、阻塞诊断和完成回执；不得新增第二套
状态机、事件总线、数据库表或通用通知框架，不得开始 S03 或修改自治模式。用户必须能看到项目/ref/HEAD、
PLAN/Slice/动作、审批与 Session 状态、Validator 分类、最后成功/错误、重试或隔离状态，以及唯一下一步；
完成回执必须包含 commit、实际验证、HANDOVER/验收入口和自动推进状态。修改任一
function/class/method 前运行 GitNexus upstream impact，HIGH/CRITICAL 先报告。完成聚焦测试、TypeScript、
定向 ESLint、`npm run check:long-files`、`git diff --check` 和 GitNexus
`detect_changes({scope: "compare", base_ref: "master"})` 后精确提交，并创建
`plan_progress: in_progress`、`next_action: next_slice` 的 S02 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
