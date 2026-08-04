---
doc_type: HANDOVER
doc_status: completed
next_action: resume_parent
plan: docs/384_PLAN_20260804_DeepSeek受限运行接入Bubblewrap沙箱.md
slice: S01
plan_progress: complete
---

# HANDOVER · DeepSeek受限运行接入Bubblewrap沙箱完成

## 完成内容与验证

1. **白名单放行** (`src/lib/acpx/runner-harness.ts`)：在允许受限运行的 harness 列表中加入 `'deepseek'`。
2. **接入沙箱包装** (`src/lib/harness/adapters/deepseek.ts` / `src/lib/real-agents/deepseek-agent.ts` / `src/lib/real-agents/deepseek-runtime.ts`)：
   - 透传 `workspaceRoot` 与 `networkAccess` 配置。
   - 使用 `wrapWithBubblewrap` 包装 DeepSeek runtime 进程，在受限工作区开启沙箱隔离。
   - 更新 DeepSeek permission support 标注 `sandboxMode` / `networkAccess` / `writableRoots` 为 `applied`。
3. **补充单测与守卫**：
   - 更新 `tests/feishu-room-controls.test.ts` 增加 `deepseek` 在 `safe_local` 下受限约束断言。
   - 新增 `tests/deepseek-agent.test.ts` 验证 DeepSeek 受限沙箱 Bubblewrap 包装逻辑与权限。
   - 执行 `npm run check:long-files` 确认无超长文件。

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/384_HANDOVER_20260804_DeepSeek受限运行接入Bubblewrap沙箱.md`、`docs/384_PLAN_20260804_DeepSeek受限运行接入Bubblewrap沙箱.md`、`docs/383_PLAN_20260804_Inbox优先级议题实施.md` 和 `docs/workflow/workflow-contract.yaml`，恢复父 PLAN `docs/383_PLAN_20260804_Inbox优先级议题实施.md` 的 S01。完成验证、创建下一 HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
