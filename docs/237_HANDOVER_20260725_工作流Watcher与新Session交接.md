---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: 235_PLAN_20260725_飞书审批卡片真实验收.md
slice: S04
plan_progress: complete
---

# 工作流 Watcher 与新 Session 交接

## 已完成

- 提交 `38d8cd6`：注册 `mold-data-webpage-tool`，审批卡目标为“科学试模助手”
  `oc_b4d2abbe3c16c3596631c3a9e756bd4f`；修复批准状态被误判为 PLAN 修订。
- 提交 `3b5f10f`：审批卡仍发业务群；`/ap new-session all`、批准后的自动化 Prompt、
  PLAN 修订指令改发 Platform Agent 私聊
  `oc_b634823504e29e6220de0cfb5108a216`，并从该私聊等待重置确认。
- watcher 专项测试、TypeScript 检查、配置解析和 `git diff --check` 已通过；
  `agent-platform-scheduled-jobs.service` 已重启并运行。
- 未触碰工作区原有的 `AGENTS.md`、`CLAUDE.md` 修改。

## 新 PLAN 检测状态

- 目标仓库：`/data1/code/mold-data-webpage-tool`
- 监听 ref：`refs/heads/rebuild-postgres-auth-slice`
- 新提交：`9056f05afef2766617085d167326e6a903ca9aec`
  （`docs: prepare 170 plan automation`，2026-07-25 21:01:20 +08:00）
- PLAN：
  `docs/codex/rebuild-postgres-auth-slice/170_PLAN_20260725_试模参数第二轮测试反馈修复.md`
- PLAN 已修正为 `plan_kind: phase` 且三个 parent 字段均为 `null`；Prompt 明确包含
  PLAN 文件名。
- 2026-07-25 21:00 的 watcher 扫描早于该提交，当时尚未检测。
- 21:10 扫描已成功检测：数据库游标更新到 `9056f05`，summary 为
  `action=start_first_slice gate=plan_review pending=true`，`lastError` 为空。
- pending path 正确指向 170 PLAN，审批卡消息 ID 为
  `om_x100b697f141cf4a0b300eaa814c30ad`，审批有效期至 21:40:04。
- 路径配置有效：目标合同的 `branch_spaces.root` 是 `docs/codex`，项目配置的
  `branch_space` 是 `rebuild-postgres-auth-slice`，最终监听目录与 PLAN 所在目录一致。

## 下一 Session 首要检查

1. 确认“科学试模助手”中的审批卡并处理；批准后 watcher 应仅向 Platform Agent 私聊发送
   `/ap new-session all` 和 PLAN Prompt。
2. 下一轮 watcher 应继续保持 `pending.gate=plan_review`，直到收到审批决定。
3. 若后续扫描失败，先看 `lastError` 和 runner journal；不要手改 cursor，也不要手工重发
   审批卡，避免幂等键重复或跳过提交。

## 运行入口

- 项目注册：`config/projects.yaml`
- watcher：`src/lib/scheduled-jobs/workflow-watcher.ts`
- 回归检查：`tests/workflow-watcher.test.ts`
- 合同：`docs/workflow/workflow-contract.yaml`
- runner：用户级 systemd 服务 `agent-platform-scheduled-jobs.service`

## 新 Session 指令

本交接提交后，可在 Platform Agent 私聊执行：

```text
/ap new-session all
```

新 Session 先读取本 HANDOVER，再继续观察 170 PLAN 的审批与启动链路。
