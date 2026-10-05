---
doc_type: PLAN
doc_status: ready
next_action: await_approval
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · LiveRoom上下文用量口径修复

## 目标与障碍

让房间脚注同时说明当前输入占模型窗口的比例和会话历史 token 消耗的窗口当量，避免把 Antigravity 一次运行内的多步累计输入误称为单轮上下文水位。原展示只有近期输入百分比，没有历史总消耗百分比；不同 harness 的用量含义也不完全相同。

## 路线与结果

本 PLAN 是单 Slice 的口径修复：从 Codex、Pi、Kimi Code 可用的会话记录提取历史总消耗，在公共脚注标明估算窗口和累计窗口当量，并让预警只依据可作为当前上下文指标的数据。完成后，用户能直接区分当前占用、历史消耗和 Antigravity 运行累计量。

## S01：统一用量口径并核验房间脚注

- **目的与结果**：同一房间的脚注能展示两类百分比；Antigravity 运行累计量不会触发错误的切会话预警。
- **实现与边界**：沿用现有适配器、标准化用量与脚注链路，补齐会话总量字段和默认窗口标记；只改这条链路及直接测试，不改数据库结构或实际模型窗口配置。
- **验收**：运行用量、四类 harness、脚注和预警相关测试、TypeScript 检查及长文件检查；人工核对累计量与当前水位措辞。
- **前置与停止**：需从现有记录中取得有明确含义的 token 数；无法确认实际窗口时必须标为估算，不能宣称真实占用。
- **交付物**：代码与测试提交、S01 HANDOVER。此次改动跨多个适配器文件，是同一个用户可见指标在四类 harness 中的一次收口。

## 验收与退出

上述检查通过且交接文档说明口径和限制后结束。历史总消耗是窗口当量，可超过 100%，不能用于判断当前上下文是否已满；真实飞书房间数值以运行时 provider 遥测为准。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/500_PLAN_20261005_LiveRoom上下文用量口径修复.md` 的 S01；读取目标 HEAD 的 `AGENTS.md`、
`docs/workflow/workflow-contract.yaml` 和本 PLAN。完成验证、创建下一 HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
