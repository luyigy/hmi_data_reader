---
doc_type: HANDOVER
doc_status: ready
next_action: resume_parent
plan: docs/020_PLAN_20260731_伯乐B&R结构修复与VLM兜底.md
slice: S2
plan_progress: complete
date: 2026-07-31
---

<!-- WORKFLOW_PROMPT_START -->
本文档 docs/022_HANDOVER_20260731_S2伯乐B&R行列结构修复PASS.md 记录 docs/020_PLAN_20260731_伯乐B&R结构修复与VLM兜底.md 的 S2（一次 B_AND_R 行列结构定向修复及分家族验收）完成情况：根因为透视畸变使右侧各行 y2 随 x 整体下移近一个行距、叠加 `#N` 列头被解析为数字进入 current 行，造成整列错位；修复仅改 `extract_temperature_b_and_r`（列头排除 + 逐列垂直对齐），复用既有 OCR 产物未重跑 OCR。验收：B_AND_R numeric_accuracy 0.9861（213/216，>= 0.95）且 error_auto_import_rate = 0（status=ok 分母 93 非空），双止损门禁均 PASS；KEBA 0.9327 与 S1 基线完全一致未回退；ZizES 21 份提取零 diff、TACT 1.0/0，均无退化。按 PLAN 不建设 VLM fallback，S3 不启动，020 PLAN 完成。
下一步回到父计划 docs/013_PLAN_20260730_主力家族温度页模板.md 的 S3：伯乐 KEBA/B_AND_R 家族温度页模板 + 真值集的阶段收口——KEBA 0.9327 是否达 013 独立家族门禁由 013 S3 判定，并处理伯乐阶段整体收口。硬约束不变：不授予生产自动入库权限，不重启服务，不执行飞书回填；候选清单批准门前不得下载新附件。
<!-- WORKFLOW_PROMPT_END -->

# 022_HANDOVER_20260731_S2 伯乐 B&R 行列结构修复 PASS

**生成时间**：2026-07-31
**基线 commit**：`e89c9ed`（开工时 HEAD；本切片仅提交 PLAN/HANDOVER 文档，代码与报告产物保留在工作区，同 S1 口径）
**执行者**：kimi-code（实施阶段执行者）

## 一句话结论

S2 一轮定向修复后 **B_AND_R 双止损门禁均 PASS**（numeric_accuracy 0.9861 ≥ 0.95、error_auto_import_rate = 0 且 ok 分母非空），按 020 PLAN 停止 Paddle 调参、**不建设 VLM fallback、S3 不启动**；KEBA/ZizES/TACT 零回退，020 PLAN 完成，回到 013 PLAN S3 收口。

## 根因（只读诊断，4 张失败图一致）

1. **透视畸变残差**： rectify + 单行线性去斜后，右侧各行 y2 随 x 整体下移 0.025–0.037（接近一个行距 min_gap≈0.038），行标签锚定在左侧（x<0.35），右侧 token 按固定 row_y 归属时整列错位一行。
2. **`#N` 列头入值**：`_num("#3")=3.0`，列头被解析为数字，在错位列占据 current 单元格（rank09 等正确图的列头则因位置高于归属阈值未入格）。
3. 二者叠加形成级联：current←列头、set←current、high←set、low←high、control←low，control 真值掉出 band 下界（旧下界 control+0.5·min_gap）。

## 修复内容（最小改动，仅 B_AND_R 路径）

`scripts/extract_fields.py` 的 `extract_temperature_b_and_r`（约 +50 行，其他家族提取路径、模板、CLAHE 合并、warning 体系均未改）：

1. `#` 前缀列头 token 不进入数值 band（阻止 `#N` 列头进入数值单元格）。
2. band 下界放宽至 control + 1.75·min_gap，使下移的加热输出真值可达（启用行无数值 token，无串扰）。
3. **逐列垂直对齐**：每列在 o ∈ [-0.6g, 1.6g] 网格搜索垂直平移量，得分 = 归属距离和 + 0.5g·未分配罚 + 1.0g·行值域越界罚（温度 [0,450] / 偏差 [0,150] / 输出 [0,100]）+ 0.05·|o| 先验；温度值 200–300°C 落入偏差行必然越界，使整组错位在评分上必然劣于正确对齐。新增 warning：`COLUMN_SHIFTED`（|o|>0.5g 的整列错位证据）、`COLUMN_ALIGN_UNASSIGNED`。

未泛调 CLAHE/灰度/二值化；未新增插件、工厂或通用框架；OCR 未重跑（复用 `output/bole_calib/rectified/` 既有基础 + CLAHE OCR 产物，仅重跑提取与比对）。

## 验收（20 图整体及分家族六指标）

报告：`output/bole_calib/accuracy_report_bole_calib.json` + `accuracy_report_bole_calib_by_family.json`（S1 修正真值之上）。

| 范围 | 样本数 | 数值分母 | 匹配数 | numeric_accuracy | status=ok 分母 | status=ok 错误 | error_auto_import_rate |
|---|---:|---:|---:|---:|---:|---:|---:|
| 整体 | 20 | 528 | 504 | 0.9545 | 147（5 图） | 0 | 0 |
| KEBA | 13 | 312 | 291 | 0.9327 | 54（2 图） | 0 | 0 |
| B_AND_R | 7 | 216 | 213 | **0.9861** | 93（3 图） | 0 | **0** |

**B_AND_R 止损门禁判定**：

| 指标 | 门槛 | 实测 | 判定 |
|---|---:|---:|---|
| numeric_accuracy | >= 0.95 | 0.9861 | PASS |
| error_auto_import_rate | 严格 = 0 且 ok 分母非空 | 0（分母 93） | PASS |

两项均通过 → 按 PLAN 停止，不建设 VLM fallback，回到 013 S3。

S1→S2 变化：整体不匹配 60→24，B_AND_R 不匹配 39→3；4 张错配图 3 张归零，rank12 仅剩 3 个不匹配（见下）。

## 回归证据

- **KEBA**：0.9327、21 个不匹配、逐图分布与 S1 基线**完全一致**（同 3 张图：rank03×1、rank20×2、rank16 reject×18），未受 B_AND_R 改动影响；KEBA 是否达 013 独立家族门禁由 013 S3 判定，不阻塞本 PLAN 的 B_AND_R 止损结论。
- **ZizES**：`output/rectified` 21 份提取重跑与 `output/extracted` 既有产物**零 diff**（status/family/page/heater_columns/fields/warnings 全等）；六指标与已提交基线 `output/accuracy_report.json` 完全一致（1.0/0）。
- **TACT**：`output/tact_calib` 6 图重跑 numeric_accuracy 1.0、error_auto_import_rate 0，与 018 基线一致。

## 剩余风险与备注

- **rank12 第 4 列仍单列错位一行**（set←高温偏差 40.0、低温偏差←输出 1.0、control 缺失，3 个不匹配）：该图状态为 review（`CURRENT_SET_INCONSISTENT` 等 warning 拦截），不误入库；一轮修复约束下不再追加迭代，留作后续扩样时观察。
- 本验收用现有 20 图既做定向修复又做验收，只证明当前样本 PoC，不构成盲测或泛化证据（PLAN §4.4）；B_AND_R 跨机台仅 Z046×6 + Z004×1。
- 20 图中 15 张非 ok（review 14 + reject 1），auto_import_ratio 0.25；review 主因 `CURRENT_SET_INCONSISTENT`（加热中真实物理偏差）与 `COLUMN_SHIFTED` 证据性告警，属保守设计。
- S3 的独立盲核真值、异常 ROI 局部 VLM fallback 等设计**未实施也不需要实施**；若未来扩样后 B_AND_R 家族门禁再次 FAIL，应新建 PLAN 而非复用本 PLAN 追加迭代。

## 改动文件

| 文件 | 改动 |
|---|---|
| `scripts/extract_fields.py` | `extract_temperature_b_and_r`：列头排除 + band 下界放宽 + 逐列垂直对齐（含 2 个新 warning）；docstring 同步 |
| `output/bole_calib/extracted/` ×20 | 复用既有 OCR 重跑提取 |
| `output/bole_calib/accuracy_report_bole_calib.json` / `..._by_family.json` | S2 验收报告（整体 + 分家族） |
| `output/tact_calib/extracted/` ×6、`output/tact_calib/accuracy_report_tact_calib.json` | TACT 回归重跑（结果与基线一致） |
| `docs/020_PLAN_20260731_伯乐B&R结构修复与VLM兜底.md` | frontmatter：doc_status completed、next_action none（S2 PASS，S3 不启动） |
| `docs/022_HANDOVER_20260731_S2伯乐B&R行列结构修复PASS.md` | 本 HANDOVER（新增） |

未修改模板、OCR 参数与其他家族提取路径；未重启服务、未执行生产写入；既有未提交改动全部保留。

## 下一步（回到 013 PLAN S3）

按 020 PLAN「S2 PASS 回到 013 S3」：伯乐 KEBA/B_AND_R 家族温度页模板 + 真值集阶段收口——KEBA 0.9327 的独立家族门禁判定、伯乐阶段整体收口与后续扩样决策。硬约束不变：候选清单批准门前不得下载新附件；不授予生产自动入库权限。
