---
doc_type: REPORT
doc_status: completed
next_action: none
---

# REPORT · Workflow Git 历史只追加防护

## 结论

提交 `cbf3385` 已为 workflow watcher 监控的 Git ref 安装本地
`reference-transaction` hook。ref 首次被 active watcher 读取后会登记为受保护 ref；
后续 fast-forward 提交正常通过，amend、rebase、reset、删除 ref 等非 fast-forward
更新会在 Git 写入前被阻止。

## 根因

watcher 依赖已提交文档、目标 ref 与数据库 cursor 的单调关系。若已被 cursor、审批卡或
执行 Session 读取的历史被改写，相同 ref 会指向另一条提交链，平台无法安全判断哪些动作
已经发生，也不能自动猜测或修复 cursor。

仅靠 Agent Prompt 和仓库说明无法约束所有本地 Git 操作，因此在 watcher 首次读取 ref 时
安装 Git 原生事务 hook，把只追加规则落实到写入边界。

## 实现边界

- 每个仓库使用 `.git/agent-platform/append-only-refs` 记录受保护 ref。
- hook 允许 ref 创建和 fast-forward，只拒绝受保护 ref 的非 fast-forward 更新或删除。
- 已存在且不由 Agent Platform 管理的 `reference-transaction` hook 不会被覆盖；watcher
  会明确报错并停止本轮处理。
- 防护是工作站本地边界，不替代远端分支保护；新 clone 由 active watcher 首次运行时安装。

## 验证

- `tests/workflow-watcher.test.ts` 验证受保护 ref 上的 `git commit --amend` 被拒绝。
- 原有历史改写检测用例会先移除测试 hook，再确认 watcher 对外部历史分叉仍保持安全阻塞。
- `npm run test:workflow-watcher`、`npx tsc --noEmit`、`npm run check:long-files`
  在代码提交前均已通过。

## 相关文件

- `src/lib/scheduled-jobs/git-history-guard.ts`
- `src/lib/scheduled-jobs/workflow-watcher.ts`
- `tests/workflow-watcher.test.ts`

本报告记录已完成的代码提交，不触发 PLAN/HANDOVER workflow 自动化。
