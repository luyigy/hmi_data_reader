---
doc_type: FIX
doc_status: completed
next_action: none
---

# FIX · Workflow Dashboard 飞书卡片字段冲突修复

## 问题与根因

- Workflow Dashboard 增加“查看文档”和“校验文档”后，两个 `select_static` 控件都使用
  `selectedDocument` 作为字段名。
- 飞书要求同一张卡片内所有具名控件的 `name` 唯一，因此服务端在创建卡片时拒绝请求；失败发生在卡片下发前，
  与回调、文档导入或 workflow 状态机无关。

## 修复

- 保留“查看文档”的 `selectedDocument` 协议，将“校验文档”字段改为
  `selectedWorkflowDocument`。
- 卡片回调优先读取原字段，并兼容读取新字段，最终仍映射到现有 `selectedDocument` 业务参数，不新增协议层。
- 回归检查改为遍历整张 Dashboard 的所有表单字段，并断言字段名全局唯一，覆盖后续新增表单时的同类冲突。
- 修复提交：`f1f3c85 fix(workflow): use unique dashboard field names`。

## 验证与当前状态

- `npx tsx -r tsconfig-paths/register tests/feishu-job-command.test.ts`：通过。
- `npx tsc --noEmit`：通过。
- 修改文件 ESLint：通过。
- `npm run check:long-files`：通过，无达到 1000 行阻断阈值的文件。
- GitNexus 修复前影响分析为 LOW：两个修改函数各有 1 个直接调用方，无受影响执行流程。
- 飞书长连接与定时任务服务已重启；真实 DM 中 Dashboard 已恢复，用户确认问题消失。

## 防止复发与遗留事项

- 本修复不改变“查看文档”、文档校验、审批、watcher cursor 或自治模式的业务语义。
- 全量 lint 仍有与本修复无关的历史错误；本次已对修改文件执行聚焦 lint。
- 回归测试会持续检查 Dashboard 表单字段名的全局唯一性。
