---
doc_type: FIX
doc_status: completed
next_action: none
---

# FIX · Workflow 人工完成 PLAN 工作区隔离修复

## 问题与根因

- Workflow Dashboard 人工完成 PLAN 时，原实现要求整个项目工作区 clean。GitNexus、其他 Agent 或人工对无关文件的修改，也会导致操作被拒绝。
- 提交虽然使用了 `--only`，但仍会执行项目 Git hook；hook 检查到无关的未完成改动时，也会阻断只提交 PLAN 的操作。
- Git 索引被其他进程占用时，底层 `index.lock` 错误直接透出，用户无法判断该操作可以稍后重试。

## 修复

- 工作区检查收窄到目标 PLAN；目标 PLAN 自身存在 staged、unstaged 或 untracked 改动时仍拒绝，避免覆盖并发修改。
- 提交限定为 `git commit --no-verify --only -- <PLAN>`，不执行全仓 hook，也不带入其他文件。
- 失败 cleanup 只恢复目标 PLAN；Git 索引锁导致 restore 不可用时，用操作前内容兜底恢复文件。
- 将 `index.lock` 和 `another git process` 错误转换为“Git 索引锁忙，请稍后重试”，保持现有完成结果协议不变。

## 验证

- `npm run test:workflow-plan-completion`：覆盖无关 staged、unstaged、untracked 文件原样保留，失败 pre-commit hook 被绕过，目标 PLAN 脏状态拒绝，以及索引锁提示和内容恢复。
- `npm run test:workflow-completion-gate`：通过。
- `npx tsc --noEmit`：通过。
- `npm run check:long-files`：通过，无达到 1000 行阻断阈值的文件。
- `git diff --check`：通过。
- GitNexus 修改前影响分析为 HIGH：`completeWorkflowPlan` 有 2 个直接调用方，影响 Dashboard 卡片处理和长连接流程；实现未改变调用方或返回协议。最终变更检测为 LOW，无受影响执行流程。

## 防止复发与后续边界

- 回归测试固定验证无关工作区状态不会被提交、恢复或删除。
- 目标 PLAN 的并发修改仍是硬拒绝条件，避免静默覆盖。
- 当前不引入专属 worktree；只有实际观察到高频索引锁冲突时，再评估 Phase 2 隔离工作区。
