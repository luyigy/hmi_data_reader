---
doc_type: HANDOVER
doc_status: blocked
next_action: blocked
plan: docs/068_PLAN_20260823_OCR主读与VLM语义辅助.md
slice: S0
plan_progress: in_progress
date: 2026-08-23
---

# 068 S0 基线合同漂移 BLOCKED 交接

## 当前状态

S0 的环境、工作区、固定样本、测试、模板链和 generic 草稿基线已建立；没有进入 S1，也没有修改代码、模板、真值或服务状态。

阻塞原因：`datasets/release_manifest.json` 与全部 111 个 dataset meta 固定在 contract `2.8.0`，当前 `contracts/field_catalog.json` 为 `2.11.0`。`scripts/datasets.py check` 产生 111 个 `contract_version` 漂移错误，因此固定样本集当前不是合同有效的验收输入。

## 已完成

- 聚焦测试：116 passed，22 subtests passed。
- 全量测试：190 passed，27 subtests passed。
- 固定清单：111 对真值/图片，0 缺图；manifest SHA-256 为 `7fe44cf41a40f7250b978dbb2950c4ca347e56b46d9edf0e4f516494d4654d7b`。
- 只读回放：89 例；模板链 numeric 0.827、generic numeric 0.0311；两者均不具备 lifecycle eligibility。
- 基线产物：`artifacts/068_s0_baseline.json`。
- 详细报告：`docs/069_REPORT_20260823_068S0_OCR与Generic基线.md`。

## 既有失败与本切片失败

- 既有失败：111 个 dataset contract 漂移；模板链三门禁失败；generic numeric/completeness 门禁失败。
- 本切片失败：0。S0 未改任何被测代码，测试全绿。
- 既有 warning：FastAPI `on_event` 弃用提示 2 条。

## 解除阻塞

不得直接开始 S1。先另行授权或立项修复 dataset meta/release manifest 与 catalog `2.11.0` 的一致性，并保证 holdout 治理不被污染；`scripts/datasets.py check` 通过后重跑 S0，再以新的合同有效 HANDOVER 派发 S1。
