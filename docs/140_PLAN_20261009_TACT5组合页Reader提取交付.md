---
doc_type: PLAN
doc_status: in_progress
next_action: none
plan_kind: phase
date: 2026-10-09
first_slice: S01
objective: "交付日精 TACT5「射出·计量」组合页的 Reader 页面模板与提取，缺项只在有印刷证据时补读"
---

# TACT5 组合页 Reader 提取交付

## 1. 背景与来源

主仓 `/data1/code/mold-data-webpage-tool` 的 `docs/dev/518_PLAN_20261008_平台Workflow驱动TACT5验收与库存接续.md` 把日精 TACT5「射出·计量」组合页列为 P01，其 S02 要求 Reader 仓以独立页面计划交付本页 OCR 模板/提取器并同图复测。本文件是该外仓页面计划；业务语义映射与保存验收均在主仓，不在本仓。

本计划登记的是已发生的交付：`cc4574f`（TACT5 注册、模板、候选观测合同、段数补读）与 `f043fad`（标量时间单位补读）先于本计划提交，本文件补齐可追溯的页面计划与交接，不追认为预先批准。剩余证据缺口见 S01 交接。

## 2. 样本与证据边界

- Z078 主图：`/data1/code/mold-data-webpage-tool/backend/data/hmi-samples/tact5.process_settings.injection_holding_metering/Z078_20260910_shebao/original.jpg`，SHA-256 `3f0cd45905b1b33b2f837b19f23003c26a563976bdde02988ef6ea4ddc18dc9d`；同目录 `truth.json` 为用户确认范围（49 个字段/槽位，灰显残值记 null）。
- Z077 同布局旁证两张：`/data1/code/hmi_finetuning/datasets/raw/feishu/20260930-focus-machine/日精/Z077/2026-09-20_recvvPKhyWe4zs_injection-holding_0.jpg`（`83d36192…de46`）与 `…_metering-cooling_0.jpg`（`2eaad728…f4b3`）；无完整人工真值，不作验收分母。
- 本页观测一律候选化：`fields={}`，不产生自动业务写入；灰显残值只作 disabled/unknown 观测，不写成有效设定。
- 补读硬约束：只补「页面锚点 + 印刷字符」同时定位的缺项（段数需「段」字、时间单位需值框右侧唯一高置信 `s` 字形）；无证据保持未知，不按模板预期单位填值。

## 3. S01：TACT5 组合页模板交付与同图复测

- **目的**：让 P01 三图经实时 HTTP 入口得到可追溯的候选观测，段数、灰显状态和时间单位缺口逐项闭环或记录无证据。
- **完成后结果**：模板、注册、提取器与合同有独立提交；聚焦与入口回归通过；三图修前/修后响应及差异交接给主仓 S02。
- **实现方法**：`templates/tact5.process_settings.injection_holding_metering.json` 页面模板 + `scripts/page_template_registry.py` 注册 + `scripts/extract_families/tact5_process.py` 候选观测提取；缺段数经 `recover_stage_counts`、缺时间单位经 `recover_time_units` 局部放大补读，均在 `hmi_service.py` 的 TACT5 profile 门内触发并同次重提取。
- **修改边界**：TACT5 模板/注册/提取/服务救援与对应测试；不改其他家族提取器、训练流程、飞书真实消息链路或主仓。飞书入口共用 `extract_tact5`，局部补读目前只接在 HTTP 服务路径。
- **验收**：`tests/test_tact5_process_settings.py`、`test_ocr_review_image.py`、`test_contract.py` 及提取/服务相关回归通过；Z078 段数 充填3/保压2/限制压力1/计量1、射出/中间单位为 s 且有 glyph 证据行；Z077 两图不产生无证据的计数或单位。
- **前置与停止条件**：原图与既有真值只读；局部补读无印刷证据时保持未知并停止该项，不降低置信阈值凑数；枚举型字段（V-P 方式/应答、手动背压、充填过量防止时间）未纳入本模板，缺证据输入（更清晰原图或用户裁定）时本片保持 blocked。
- **交付物**：上述代码提交、测试结果、三图修后响应摘要与 S01 HANDOVER 独立提交。
