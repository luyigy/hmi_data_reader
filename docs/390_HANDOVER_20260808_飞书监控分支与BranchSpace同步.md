---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/389_PLAN_20260808_飞书监控分支与BranchSpace同步.md
slice: S01
plan_progress: complete
---

# HANDOVER · 飞书监控分支与 Branch Space 同步

## 完成内容

- `/ap branch apply [branch] [--branch-space=name]` 现在始终创建确认申请，包括管理员发起的申请。
- 默认 branch space 使用分支名最后一段；用户可显式覆盖，卡片展示完整监控目录。
- 申请和批准阶段均验证本地目标 ref、目标 ref 中的 workflow contract，以及已提交的 branch-space 目录。
- 缺少目录时不向目标仓库自动提交占位文件，而是返回应先提交首个 PLAN/HANDOVER 的准确路径。
- 审批生效时检查当前 `ref` 与 `branch_space` 仍等于申请基线，然后通过临时文件替换同时更新二者。
- watcher 正在运行或 cursor 仍有 pending 时拒绝切换，避免把旧 branch space 的状态带入新分支。
- `/ap branch switch` 复用相同校验；无 `/` 的普通分支名不再被误判为项目 ID。
- 当前 `mold-data-webpage-tool` 配置已指向
  `refs/heads/codex/machine-converter-release-20260807-r2` 与
  `machine-converter-release-20260807-r2`。

## 验证

- `npm run test:project-branch`：通过；测试环境未配置 `FEISHU_APP_ID`，模拟发卡被预期捕获，未产生真实飞书写入。
- `tests/feishu-job-command.test.ts`：通过。
- `npm run test:workflow-watcher`：通过。
- `npx tsc --noEmit`：通过。
- 相关 ESLint：通过。
- `npm run build`：通过。
- `npm run check:long-files`：通过，无 1000 行阻断文件。
- 相关文件 `git diff --check`：通过。

## 未完成与验收

- 未重启 Feishu runtime 或 scheduled-job runtime；用户将在提交后自行重启。
- 未执行真实 `/ap branch apply` 审批往返；重启后应在绑定项目群进行一次真实验收。
- `tests/feishu-help-command.test.ts` 仍有开工前已存在的分页断言失败：测试在“权限与管理”页查找
  `/ap branch status`，而命令实际位于 Workflow 页；本 Slice 未扩展范围修复。
- 工作区仍有 Dashboard 表单重排、GitNexus 配置等其他未提交改动，本提交不得包含它们。

## 下一 Session 建议 Prompt

```text
读取 docs/390_HANDOVER_20260808_飞书监控分支与BranchSpace同步.md、docs/389_PLAN_20260808_飞书监控分支与BranchSpace同步.md 和 docs/workflow/workflow-contract.yaml，对 S01 做真实飞书验收：经用户明确批准后重启相关服务，在绑定群执行 /ap branch apply，确认卡片展示并同步 ref、branch_space 与完整监控目录。只处理验收发现的回归，不清理其他脏改动。
```
