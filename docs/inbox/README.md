# Workflow Inbox

本目录是 workflow `auto` 模式使用的 Git Inbox，不是本地临时草稿目录。

## 使用约定

1. 每个候选需求使用一个已提交的 Markdown 文件；一级标题作为候选名称，正文描述范围和验收目标。
2. `README.md` 只说明规则，watcher 会忽略它。
3. watcher 只读取目标 Git HEAD 中已提交的内容，不读取工作区草稿。
4. 只有 `auto` 在 phase PLAN 完成后可从此处提议新 PLAN；`manual` 和 `semi_auto` 不消费 Inbox。
5. 新 PLAN 仍需用户审批。已有 PLAN 记录相同 `WORKFLOW_INBOX_ITEM` 时不会重复认领。
6. 不在候选文件中保存凭证、Token、个人数据或未经授权的真实环境信息。
