---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: 253_PLAN_20260726_审批后新Session与Prompt全链路验收.md
slice: S01
plan_progress: complete
---

# HANDOVER · PLAN 修改意见幂等修复

## 结果

已修复审批人第一次提交修改意见时，Coding Agent 投递被旧 `reply_queued` 幂等记录吞掉，
以及 watcher 把提交意见前的历史 PLAN 改动误判为本轮修订完成的问题。

## 修改

- 有内容的修改意见统一生成独立的 `:feedback` dispatch key。
- watcher 投递修订任务前，以当时目标 HEAD 中的 PLAN blob 作为本轮修订基线。
- 回归测试覆盖新 dispatch key 和旧 blob 不会触发虚假 `revised=true`。

## 验证

- `npm run test:workflow-watcher`
- `npm run test:scheduled-jobs`
- `npx tsc --noEmit`
- 修改文件 ESLint
- `git diff --check`

GitNexus MCP 返回 `Transport closed`，本地 CLI 在读取索引 WAL 时段错误，因此未能生成
`detect_changes` 报告。源码调用链和聚焦测试确认影响范围限于 PLAN 修改反馈状态转换与
workflow watcher 修订分支。

## 后续

用户重启服务后，通过新的 PLAN 审批卡提交一次修改意见，确认第一次即启动 Coding Agent，
且只有 Agent 提交本次修改后 watcher 才重新发送审批卡。
