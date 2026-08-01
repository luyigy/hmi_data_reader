---
doc_type: HANDOVER
doc_status: ready
next_action: await_acceptance
plan: docs/031_PLAN_20260801_TACT第一波扩样.md
slice: S5
plan_progress: in_progress
date: 2026-08-01
---

# 032_HANDOVER_20260801 TACT 泛化验收 FAIL：模板不泛化

**生成时间**：2026-08-01
**执行者**：kimi-code（自动模式 027 §3）
**验收口径**：031 PLAN S5——**现有** `templates/tact.temperature.json` 不动，18 图跑一次

## 一句话结论

扩样要回答的问题有了明确答案：**现有 TACT 模板（Z022 单机五段锚点）不能跨机台泛化**，numeric 0.4884 FAIL；安全面干净（无 ok 图、零误放行）；真值与核验表资产已备，可直接支撑模板整改后的复验。

## 验收结果（output/tact_exp_calib/accuracy_report_tact_exp.json）

| 指标 | 结果 | 门槛 | 判定 |
|---|---:|---:|---|
| controller_classification_accuracy | 1.0（18/18） | — | — |
| page_classification_accuracy | 0.9444（17/18） | — | — |
| field_completeness | 0.6676 | — | — |
| numeric_accuracy | **0.4884** | ≥ 0.95 | **FAIL** |
| auto_import_ratio | 0.0（0/18） | — | — |
| error_auto_import_rate | 空分母（无 ok 图） | = 0 | **FAIL（空分母规则）** |
| rejection_accuracy | N/A（无负样本） | = 1 | N/A |

## FAIL 根因（177 个不匹配的分类）

1. **四段变体错位（Z015×6、Z019×6，约 140 个）**：模板按 Z022 五段（喷嘴/筒头/前部/中部/后部）锚定段列；Z015/Z019 为四段（喷嘴/前部/中部/后部，无筒头），段列整体左移一位，`筒头` 段不存在导致 `ZONE_HEADER_FALLBACK` + 全列 CELL_MISSING，set/current/control/holding 大面积错位。这是 numeric 崩塌的主因。
2. **五段 Z025 局部失配（约 37 个）**：同构但落下口设定 30.0（Z022 为 50.0）+ 个别图落下口/设定行单元格漏检（斜拍反光）+ holding LOW_CONF。
3. **页面误判 1 张**：rank14（Z025 2026-01-10）被分类器判为 monitor_curve（实际温度页），NO_TEMPLATE 拒提。

## 过程记录（031 全切片）

- S1：Z015/Z019/Z025 各 6 目标 + 12 候补下载，18/18 零重复（排重覆盖 Z022 既有真值与校准集）。
- S2：18 份 VLM 草稿。**抽验抓脏**：Z019 rank10 为 TRD6（沙迪克 SPT）屏——大表该机台记录混入别家屏，按候补固定顺序 rank23 补位，已记 manifest 与 machine_labels 备注。
- S3：飞书「TACT扩样字段核验」18 行（见 `output/tact_exp_verify_table_records.json`）。
- S4：真值 ×18 落盘 `ground_truth/tact_exp_temperature/`（自动整批接受，降级标注，用户事后否决权有效）。
- S5：本验收（一次、冻结、如实）。

## 变体图谱（新事实）

| 机台 | 段数 | 段标签 | 落下口设定 | 落下口控制输出 |
|---|---:|---|---|---|
| Z022（原） | 5 | 喷嘴/筒头/前部/中部/后部 | 50.0 | 有 |
| Z025 | 5 | 同 Z022 | 30.0 | 无 |
| Z015 | 4 | 喷嘴/前部/中部/后部 | 55.0 | 无 |
| Z019 | 4 | 同 Z015 | 40.0/50.0 | 无 |

## 路径交审批

1. **模板参数化**（建议）：TACT 提取改为按段头标签动态定位段数与列位（四/五段自适应），工作量中等，改后直接用本批 18 真值复验；
2. **分变体模板**：四段/五段各一份模板（维护成本翻倍）；
3. **暂停 TACT 扩样**：维持 Z022 单机 PoC 现态。

## 修改文件

| 文件 | 改动 |
|---|---|
| `scripts/s14_tact_exp_candidates.py`、`s15_download_tact_exp.py`、`s16_build_tact_exp_verify_table.py`、`s17_tact_exp_truth_accept.py` | 新增 |
| `ground_truth/tact_exp_temperature/` ×18、`output/tact_exp_*`（candidates/manifest/drafts/verify_table_records/calib 全套） | 切片产物 |
| `docs/samples_tact_exp/` ×30 | 下载样本 |
| `docs/032_HANDOVER_20260801_TACT泛化验收FAIL_模板不泛化.md` | 本 HANDOVER |

未改模板、提取器、既有真值；既有家族（ZizES/伯乐/FANUC/DEMAG/TACT-Z022）产物未触碰。
