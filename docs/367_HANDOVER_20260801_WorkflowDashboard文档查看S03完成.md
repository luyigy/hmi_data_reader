---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/364_PLAN_20260801_WorkflowDashboard队列与文档按需查看.md
slice: S03
plan_progress: complete
---

# HANDOVER · Workflow Dashboard 文档查看 S03 完成

## 完成内容

- 飞书 Workflow Dashboard 新增单文档选择表单，统一列出 Inbox、未完成 PLAN 和相关 HANDOVER，并提供
  “查看飞书文档”按钮。
- 点击后复用现有 Markdown → 飞书 Docx 导入和当前卡片消息回复链；原 `/ap doc` 与 watcher 导入也共享同一
  幂等实现。
- 导出先解析项目目标 ref 的提交，再按该 commit 读取文件；卡片 HEAD 过期时明确提示版本已更新，不读取工作区草稿。
- 同一服务实例内按仓库、commit 和路径复用进行中或已成功的导入结果；失败结果不缓存，可保留原卡片选择重试。
- 文档导出不会修改 workflow cursor、队列、审批、自治模式或执行状态，也不会在完成后发送无意义的重复 Dashboard。

## 验证

- `npx tsx tests/feishu-document-command.test.ts`：通过，覆盖 Markdown 处理、路径边界、重复导入复用和失败重试。
- `npx tsx tests/feishu-job-command.test.ts`：通过，覆盖 Inbox、PLAN、HANDOVER 三类选项及文档提交动作。
- `npm run test:workflow-watcher`：通过，包含预期的 Git 历史改写拒绝场景。
- `npx tsc --noEmit`：通过。
- 本次变更文件 ESLint：通过。
- `npm run check:long-files`：通过，无达到 1000 行阻断阈值的文件。
- `git diff --check`：通过。

## 验收与边界

- 本机没有可用的 `lark-cli` 与真实飞书会话，因此未创建真实 Docx；部署或重启服务后需在已绑定项目会话各选择
  Inbox、PLAN、HANDOVER 一项，确认链接可打开，并重复点击确认返回相同链接。
- 当前幂等缓存适配 Platform Local 单服务实例；只有部署为多实例并需要跨实例复用时才需持久化映射。
- GitNexus MCP 未暴露，本地 runner 因 `onnxruntime-node` 安装损坏退出；已用完整调用点检查和定向回归确认影响仅在
  文档导入、Dashboard 卡片与卡片回调链。
- 本 PLAN 已完成，终态等待真人验收，不自动启动下一 Slice。
