---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/352_PLAN_20260801_Workflow模板校验与Inbox录入闭环.md
slice: S04
plan_progress: complete
---

# HANDOVER · Workflow 模板、校验修复与 Inbox 录入闭环 S04 完成

## 完成内容

- 新增 `/ap inbox add <标题> [--body=<说明>] --head=<40位HEAD>`，只允许唯一绑定的 Workflow 项目、平台管理员
  或项目审批人操作。
- 复用目标仓库合同、branch space、当前 branch、40 位 HEAD 乐观锁和 clean/conflict guard；提交前再次核对 HEAD
  与工作区，只提交新 ISSUE 文件。
- 生成 branch space 内递增编号的 `docs/inbox/<编号>_ISSUE_<日期>_<标题>.md`，frontmatter 固定为
  `doc_type: ISSUE / doc_status: draft / next_action: none`，不会领取 ISSUE、生成 PLAN 或改变自治模式。
- 标题和正文限制长度、控制字符、路径字符及常见密码/Token/密钥赋值；正文只作为 Markdown 数据保存，不执行命令。
- ISSUE 内保存请求与内容哈希标记；同一 Feishu 消息或相同内容在进程重启后仍返回既有 ISSUE，不重复提交。
  同项目 watcher 写入使用现有 PostgreSQL advisory lock 串行化，不新增表、队列或轮询器。
- 将 `docs/inbox/349_ISSUE_20260801_网页平台登录认证与Inbox快捷记录命令.md` 标记为 `superseded`：Inbox
  部分由本 PLAN 完成，未实施的网页登录/RBAC 继续保留在 `docs/inbox/357_ISSUE_20260801_网页平台登录认证与RBAC.md`。

## 验证

- `npm run test:workflow-roadmap-inbox`：覆盖命令解析、权限、输入边界、递增编号、draft ISSUE、正文不执行、过期
  HEAD、dirty、Git conflict、多 consumer、同消息/同内容幂等，以及 manual/semi_auto 不消费、auto 只提议一个 PLAN
  并停在审批前。
- `npm run test:workflow-validator`
- `npm run test:git-history-guard`
- `npm run test:workflow-watcher`
- `npm run test:workflow-autonomy`
- `npm run test:workflow-completion-gate`
- `npm run test:scheduled-jobs`
- Feishu plan/job/help/mode 命令测试
- `npx tsc --noEmit --pretty false`
- 定向 ESLint、`npm run check:long-files`、`git diff --check`

未发送真实 Feishu 消息、未重启服务、未修改真实项目自治模式或共享业务数据。真实可见性仍需部署/重启后由管理员或
审批人在已绑定会话发送一次命令验收。

## 工作区与后续边界

- 开工前已有的 `AGENTS.md`、`CLAUDE.md`、Workflow 计划清单 UI/status/inspection 和相关测试改动保持未提交，
  不纳入 S04。
- 用户提出的“检查现有任务、选择排序、跳过和校验加强”不属于 S04；应在本 PLAN 验收后单独确认现有工作区实现、
  补齐规则和回归，避免与本次 Inbox 写入提交混合。
- 本 PLAN 已完成，终态等待验收，不自动启动下一 Slice。
