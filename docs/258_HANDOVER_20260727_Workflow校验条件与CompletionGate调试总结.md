---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: 257_PLAN_20260727_WorkflowCompletionGate触发边界修复.md
slice: S01
plan_progress: complete
---

# HANDOVER · Workflow 校验条件与 Completion Gate 调试总结

## 问题与根因

1. PLAN 字段校验原本由 `documents.plan.required_fields` 统一要求
   `roadmap` 和三个父级字段，导致 phase PLAN 也报告不必要的缺字段错误。
2. validator 改为读取 `required_fields_by_kind` 后，运行中出现“新代码读取旧提交合同”的
   混合版本，旧合同缺少新键时直接失败。
3. completion gate 原本对所有 `platform_local` 执行建立 baseline，使普通飞书直聊也读取
   workflow contract，合同版本不一致时普通 Codex 回复同样失败。
4. watcher 只读取目标 Git ref 中已提交的合同；平台工作区 YAML 或测试仓库未提交的 YAML
   不会改变真实 watcher 行为。

## 完成内容

- 合同规则改为：
  - phase PLAN：必填 `plan_kind`；`roadmap` 与父级字段可省略。
  - interrupt PLAN：在通用字段之外额外必填 `parent_plan`、`parent_slice`、`return_to`。
  - Slice 与可执行动作 Prompt 继续由 validator 校验。
- validator 从合同组合通用字段和按 kind 字段，不再硬编码 interrupt 的三个字段。
- `required_fields_by_kind` 对旧合同向后兼容；缺键时按空映射处理，旧合同原有
  `required_fields` 语义保持不变。
- completion gate 只在显式 `workflowCompletionGate: true` 且 backend 为
  `platform_local` 时启用。
- watcher 产生的 live-room 消息复用已有 `source: workflow_watcher` 元数据开启 gate；
  普通飞书直聊和普通本地任务默认关闭。
- watcher 启动的新 Session 会附带目标 HEAD validator 命令提醒。
- `workflow-test` 的合同已在其独立仓库提交为 `d9d8275`；第四轮假 PLAN 的真实错误已从
  7 项降为缺 Prompt、`plan_kind`、Slice 三项。后续补 Prompt 后应剩两项。

## 验证结果

- `npm run test:workflow-completion-gate`：通过。
- `npm run test:workflow-validator`：通过，包含旧合同兼容场景。
- `npm run test:workflow-watcher`：通过。
- `tests/feishu-live-room-relay.test.ts`：通过。
- `npx tsc --noEmit`：通过。
- `git diff --check`：通过。
- 使用工作区新代码读取当前 HEAD 旧合同并校验 256 PLAN：通过。
- 使用 `workflow-test` 提交 `d9d8275` 校验 006 PLAN：只报告推荐规则下的三项错误。
- GitNexus `detect_changes` 已运行；共享 ACPX 入口和 validator 链路风险为
  HIGH/CRITICAL，已用显式默认关闭标识和聚焦回归控制影响。

## 提交边界

本次提交只包含 workflow 合同、validator、watcher 提醒、completion gate 触发边界、
live-room 标识透传、对应测试、257 PLAN 与本 HANDOVER。以下现有工作区改动不属于本次提交：

- `AGENTS.md`、`CLAUDE.md`
- `config/projects.yaml`
- `docs/SYSTEMD_USER_COMMANDS.md`
- `src/lib/feishu-new-session.ts`
- `tests/feishu-live-room-relay.test.ts`

## 后续

当前切片已完成，等待验收。若继续测试 `workflow-test` 的 006 PLAN，只需补齐 `plan_kind` 和
至少一个 Slice；不要用 `cursor --latest` 跳过该测试提交。
