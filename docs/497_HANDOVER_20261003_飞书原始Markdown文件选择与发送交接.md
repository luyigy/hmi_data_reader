---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/496_PLAN_20261003_飞书原始Markdown文件选择与发送.md
slice: S01
plan_progress: complete
---

# HANDOVER · 飞书原始Markdown文件选择与发送交接

## 已交付

- 新增 `/ap md [关键词|完整路径.md]`。无参数时回复原始 MD 选择卡；关键词筛选已提交文件；完整路径直接发送原始文件。
- 选择卡默认打开 `docs` 交接，另有 `docs` PLAN、`docs` 其他、仓库其他位置三个分区。各区按文件编号倒序，最多展示最新 100 个；分区按钮更新原卡。更早文件可通过关键词筛选。
- 发送时从固定 Git HEAD 读取文件字节并上传为飞书文件。复用 Live Room 工作目录与文档访问权限；卡片所属房间或 HEAD 不匹配时拒绝旧卡操作。
- `/ap doc` 仍用于导入飞书文档；帮助文字已增加 `/ap md` 用法。

## 验证

- `tests/feishu-markdown-file.test.ts`：分区默认值、倒序与 100 项上限、卡片大小、文件上传与回复字节一致。
- `tests/feishu-document-command.test.ts`、`tests/feishu-job-command.test.ts`：通过。
- `npx tsc --noEmit`、`npm run check:long-files`、`git diff --check`：通过；无达到 1000 行阻断阈值的源文件。
- 本地仓库含 495 个已提交的中文文件名 MD 时，默认卡约 21 KB，PLAN 卡约 12 KB。

## 验收入口与遗留事项

在绑定本仓库的飞书 Live Room 发送 `/ap md`，确认默认交接列表、四个分区的原卡切换、选中文件回复及关键词筛选。当前运行中的飞书服务不会自动加载本次代码；本轮结束后需重启 `agent-platform-feishu.service`，然后做真实点击验证。当前验证仅覆盖本地构卡与模拟 API 请求，尚未完成真实飞书点击。

本次提交仅纳入 `/ap md` 实现、直接测试与本 HANDOVER；工作区中其他任务的改动仍独立保留。
