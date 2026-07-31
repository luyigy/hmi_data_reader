---
doc_type: HANDOVER
doc_status: ready
plan: docs/013_PLAN_20260730_主力家族温度页模板.md
slice: S2
plan_progress: complete
next_action: next_slice
date: 2026-07-31
---

<!-- WORKFLOW_PROMPT_START -->
本文档 docs/018_HANDOVER_20260731_S2日精TACT模板与真值.md 记录 docs/013_PLAN_20260730_主力家族温度页模板.md 的 S2（日精 TACT 家族温度页模板 + 真值集）完成情况：6 图验收 numeric_accuracy 1.0（≥0.95 达标）、error_auto_import_rate 0，TACT 模板 v0.1.0 与 6 份真值落盘；同时收口 docs/015_PLAN_20260731_TACT温度页模板校准与链路验收.md 的 S2（六图完整链路 + 六指标报告）。
下一步执行 013 PLAN 的 S3：伯乐 KEBA/B_AND_R 家族温度页模板 + 真值集。硬约束不变：候选清单经用户批准后才下载大表附件；不授予生产自动入库权限。
<!-- WORKFLOW_PROMPT_END -->

# 018_HANDOVER_20260731_S2 日精 TACT 模板与真值

**生成时间**：2026-07-31
**基线**：S1 整改后基线 `7acbb32` 之上
**文档关系**：模板校准细节见 `docs/016_HANDOVER_20260731_TACT温度页模板与最小链路支持.md`（015_PLAN S1，codex 执行）；本文档覆盖 013_PLAN S2 全程并收口 015_PLAN S2。编号 015–017 已被占用，本文档顺延为 018。

---

## 一句话结论

S2 验收通过：TACT 温度页模板（`templates/tact.temperature.json` v0.1.0）+ 6 份用户确认真值（`ground_truth/tact_temperature/`）落盘；链路 6 项指标 **numeric_accuracy 1.0、field_completeness 1.0、error_auto_import_rate 0、auto_import_ratio 5/6**，双门禁（≥0.95 / =0）均达标。

## 执行过程（按 013 PLAN S2 流程）

1. **只读盘点**（`scripts/s2_tact_pool_inventory.py` → `output/tact_pool_inventory.json`）：日精 1992 条，TACT 候选池仅 Z022/A06 一台 431 条（B09/B10 为日精新机器，大表无记录）。
2. **候选清单**（`output/tact_expansion_candidates.json`，seed 20260731）：6 目标 + 4 候补，全部 Z022；**样本结构由 3 台 × 6 降级为 1 台 × 6**，用户知悉。
3. **用户批准**（Live Room「继续」2026-07-31，按 009 先例落盘 APPROVED）后下载 10 条附件（`scripts/s2_download_tact.py`）：6/6 目标内容级 SHA-256 零重复、零失败（`output/tact_sample_manifest.json`，图片 `docs/samples_tact/`）。
4. **VLM 预标注草稿**（`output/tact_drafts/`×6）→ 飞书核验表「TACT温度页字段核验」（tblSnjQzDzkpGvD9）预填 → **用户整批确认无误**（未逐字段粘贴，脚本按草稿回填确认列，降级口径与 2026-07-30 简化流程一致）→ 真值落盘 ×6（`changed_fields=0`）。
5. **模板校准**（codex）：rectify 四角矫正 6/6 成功 → 区段中文列头 + 行标签锚定的归一化坐标模板 v0.1.0；`extract_fields.py` 新增 `extract_temperature_tact`；`verify_accuracy.py` NUMERIC_FIELDS 补 TACT 字段并加真值覆盖硬检查（防漏算假高分）。
6. **首轮跑分不达标**（numeric 0.9493 < 0.95）：保温温度行白底框漏检 5 格、rank01 落下口「33.3」误读「866」+「40.0」漏检。
7. **链路修复**（本切片第二轮）：CLAHE 变体 OCR 补充召回，复跑 **numeric 1.0 / completeness 1.0 / 双门禁 PASS**（`output/tact_calib/accuracy_report_tact_calib.json`）。

## CLAHE 变体 OCR 修复（改动文件）

- `scripts/ocr_one.py`：新增 `--clahe-output`，同一 PaddleOCR 实例对灰度 CLAHE（clip 3.0, tile 8×8）变体再跑一次，输出 `<stem>.ocr_clahe.json`。
- `scripts/extract_fields.py`：新增 `merge_variant_lines`——同位（IoU≥0.2 或互含中心）仅在基础 conf<0.7 且变体 conf≥0.9 时替换、空位才补充；**仅 TACT 模板路径合并**，ZizES 路径与口径不受影响。
- `scripts/run_pipeline.py`：新增 `--ocr-clahe` 开关（默认关）。

合并规模（6 图）：added 1/10/5/4/0/2、replaced 各 ≤1（含 rank01 「866→33.3」）。合并后全部 138 个数值元素与真值一致。

## 验收指标（`output/tact_calib/accuracy_report_tact_calib.json`）

| 指标 | 首轮 | 修复后 |
|---|---:|---:|
| controller/page 分类准确率 | 1.0 / 1.0 | 1.0 / 1.0 |
| field_completeness | 0.9565 | **1.0** |
| numeric_accuracy | 0.9493 | **1.0**（门 0.95） |
| auto_import_ratio | 0.3333 | 0.8333（5/6） |
| error_auto_import_rate | 0 | **0**（门 =0） |

rank04 为 review：`CURRENT_SET_INCONSISTENT(后部: 254.6 vs 260.0)`——真值即加热中物理状态（差 5.4°C > ±5°C 容差），保守拒自动入库，属设计行为非提取错误。

## 产物清单

| 产物 | 路径 |
|---|---|
| TACT 模板 v0.1.0 | `templates/tact.temperature.json` |
| 真值 ×6 | `ground_truth/tact_temperature/` |
| 样本图 ×10 | `docs/samples_tact/` |
| 验收报告 | `output/tact_calib/accuracy_report_tact_calib.json` |
| 下载/建表脚本 | `scripts/s2_download_tact.py`、`scripts/s3_build_tact_verify_table.py` |
| 进度 checkpoint | `output/s2_progress.json` |

## 风险与备注

- **单机台降级**：模板与真值均来自 Z022/A06 一台，跨机台/跨 TACT 屏变体泛化未验证；B09/B10 真值只能复用本地 samples_v2 rec03/04/05，未纳入本验收。
- 候选清单中 9 台无家族证据日精机台（`unknown_pending_decision`）仍挂起待用户裁定。
- CLAHE 合并规则保守（替换需 conf 0.59→1.00 级差距），但仅经 6 张校准图验证；后续家族验收若现误放行迹象回查本规则。
- 本切片改动（含 codex 的模板/提取器与本次 OCR 变体修复）随本次提交固化（用户 2026-07-31 指示「提交之后再进行下一步」）。

## 下一步（S3）

按 013 PLAN：伯乐 KEBA（A01/B02）+ B_AND_R（B01）家族温度页模板 + 真值集。先只读盘点出候选清单，**用户批准后才下载大表附件**。
