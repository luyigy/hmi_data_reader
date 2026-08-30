# 修复记录：工作流换代派发误生成 Session 换代检查点（2026-08-30）

## 现象

科学试模助手（mold-data-webpage-tool，branch_space `docs/dev/`）S04 完成后，S05 的
`next_slice` 派发每分钟失败一次，并在目标仓库 `docs/` 根目录持续生成
`NNN_HANDOVER_20260830_Session换代_*.md` 暂存残留（011、012、013 …）。

两类报错先后出现：

1. `Command failed: git commit --only -m docs(session): checkpoint before rotation ...`
   （目标仓库 reference-transaction 钩子以 `PROMPT_FORBIDDEN` 拒绝：检查点内嵌的最近
   transcript 复读了 `<!-- WORKFLOW_PROMPT_START/END -->` 标记，非可执行文档不得包含）。
2. `workflow session rotation failed: 旧 Agent 运行未能实际终止`（换代尝试停止房间内
   仍在运行的 Agent 回复失败，属预期重试，不是根因）。

## 根因

1. `feishu-workflow.ts` 从上一轮 Prompt 提取建议 Handover 的正则
   `docs\/\d+_HANDOVER_\d{8}_...` 只匹配 `docs/` 根目录布局，无法匹配
   `docs/dev/229_HANDOVER_...md`。建议路径为空 → 平台误判"没有已提交 Handover"→
   走应急生成分支。
2. 应急生成器把最近 30 条房间消息原样嵌入检查点；上一轮 Agent 按合同在最终回复中复读
   了 Prompt 标记，导致生成的检查点必然携带标记，被目标仓库工作流校验钩子拒绝；提交
   失败后文件残留在暂存区，下一次重试再生成一个新的编号文件。
3. `rotation_pending` 重试分支没有传 `suggestedPath`，即使首轮已能提取建议路径，重试
   时也会退回应急生成。

## 修复（commit b4f6e83）

- `workflow-session-rotation.ts`：新增 `suggestHandoverPathFromPrompt`，接受
  `docs/<branch_space>/NNN_HANDOVER_YYYYMMDD_*.md` 多级目录路径。
- `feishu-workflow.ts`：`prepared` 与 `rotation_pending` 两个分支都传入建议路径；
  命中已提交 Handover 时直接复用，不再生成应急检查点。
- `feishu-new-session.ts`：
  - 生成检查点前用 `redactWorkflowPromptMarkers` 脱敏 transcript 中的
    `*PROMPT_START/END` 标记（保留正文，替换标记字符串）。
  - 检查点提交失败（如被钩子拒绝）时，撤销暂存并删除该文件，避免残留累积。

## 验证

- `npm run test:workflow-session-rotation`：新增 docs/dev 子目录、docs 根、PLAN/TODO
  不匹配等用例。
- `npm run test:new-session-rotation`：transcript 含标记时，落库检查点不含原始标记。
- `tests/workflow-dispatch-recovery.test.ts`、`npm run test:workflow-watcher` 通过；
  `npx tsc --noEmit` 无错误。
- 重启 `agent-platform-scheduled-jobs.service` 后观察：目标仓库不再新增换代文件，
  派发失败原因只剩"旧 Agent 运行未能实际终止"（等待房间内运行中的回复结束，属预期）。

## 运维备注

- 历史 `docs/NNN_HANDOVER_..._Session换代_*.md`（001–013）保留在 Git 历史中，不回收。
  未提交的重复残留（011/012）由当值 Agent 清理或脱敏后提交即可。
- 本修复不改变合同、扫描边界或游标，不需要移动 watcher 游标。
