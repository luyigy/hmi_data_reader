---
doc_type: PLAN
doc_status: completed
next_action: await_acceptance
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · 飞书监控分支与 Branch Space 同步

## S01：分支切换前置校验与原子配置更新

修复 `/ap branch apply` 只更新项目 Git `ref`、未同步 workflow watcher `branch_space` 的问题。

完成标准：

- 申请卡明确展示目标 ref、branch space 和完整监控目录；
- 目标 ref、workflow contract 或已提交监控目录不存在时拒绝申请；
- watcher 正在运行或仍有 pending 时拒绝切换；
- 审批生效前重新校验申请基线，并在一次 YAML 文件替换中同时更新 `ref` 与 `branch_space`；
- 管理员显式 `switch` 命令采用相同校验；
- 聚焦测试、TypeScript、ESLint、生产构建和长文件守卫通过。
