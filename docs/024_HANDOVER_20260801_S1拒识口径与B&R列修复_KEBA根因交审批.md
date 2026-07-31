---
doc_type: HANDOVER
doc_status: ready
next_action: await_acceptance
plan: docs/023_PLAN_20260801_伯乐S3拒识口径与定向收口.md
slice: S1
plan_progress: in_progress
date: 2026-08-01
---

<!-- WORKFLOW_PROMPT_START -->
本文档 docs/024_HANDOVER_20260801_S1拒识口径与B&R列修复_KEBA根因交审批.md 记录 docs/023_PLAN_20260801_伯乐S3拒识口径与定向收口.md 的 S1 完成情况与一项停止事项：①verify_accuracy.py v1.1 拒识计分口径已实现（正确拒识排除计分、rejection_accuracy 独立硬门禁、全量/计分/排除三计数可审计），17 项合成聚焦检查全过，含「错误放行负样本不能靠排除分母获 PASS」；②B_AND_R rank12 第 4 列关联错位已根因修复（行值域硬约束，set/low/control 与真值一致，其余 6 张 B_AND_R fields 零 diff）；③KEBA rank20/rank03 单值区三项问题经两路 OCR token 全景与原图复核确认为 OCR 检测/识别层失败（180/58 未检出、48 被两路一致高置信误读为 49），在本 PLAN 约束（不泛调图像参数、不引入 VLM、不做单图特判）下无法于家族函数内局部修复，按 PLAN §2/§4 准确记录并停止，未进 S2。家族边界：KEBA 13 图与 ZizES 21 图提取零 diff，TACT 路径未改。
下一步交回审批：KEBA 三项残留需 OCR 层手段（检测分辨率、新 OCR 变体或 VLM），均超出 023 scope_out 且 det_limit_side_len 调整在 016 已留待用户决策；若审批接受残留，可按 023 S2 入口以冻结的口径与提取跑一次 20 图验收（KEBA 计分分母将变为 294，残留 3 个不匹配 + B_AND_R rank12 current 缺格 1 个，预计仍过 0.95 门，但须如实报告）。硬约束不变：不授予生产自动入库权限，不重启服务，不执行飞书回填。
<!-- WORKFLOW_PROMPT_END -->

# 024_HANDOVER_20260801_S1 拒识口径与 B&R 列修复，KEBA 根因交审批

**生成时间**：2026-08-01
**基线 commit**：`4f8a653`（开工时 HEAD；本切片仅提交 PLAN/HANDOVER 文档，代码与检查产物保留在工作区）
**执行者**：kimi-code（实施阶段执行者）

## 一句话结论

S1 三项交付完成两项、一项按 PLAN 停止条件如实上报：拒识计分口径与 B_AND_R rank12 列关联修复完成且有聚焦检查证据；**KEBA rank20/rank03 三项问题确证为 OCR 层失败，无法在本 PLAN 约束内局部修复，不进入 S2，交回审批**。

## 开工核对

- 已从 HEAD 读取 `docs/workflow/workflow-contract.yaml`、本 PLAN、013/020 PLAN、022 HANDOVER；分支 `master`（开工时领先 origin 31）。
- 工作区非本 Slice 改动（015/019 文档更正、machine_labels、bole_expansion_candidates 及 020 S2 遗留代码/产物）全部保留未触碰。

## 交付 1：拒识计分口径（`scripts/verify_accuracy.py` v1.0→v1.1）

- 仅真值 `allow_auto_import=false` 且提取 `status != ok` 的正确拒识图，其数值元素从 `field_completeness`/`numeric_accuracy` 分母分子排除；错误放行（`status=ok`）负样本**不排除**。
- 新增 `rejection_accuracy`（正确拒识数 / `allow_auto_import=false` 图数），门槛严格 = 1，空分母记 `"N/A"`（不宣称 PASS；伯乐批分母 = 1，即 rank16）。
- 空分母语义修正：`numeric_accuracy`/`error_auto_import_rate` 空分母 gate FAIL（原 `or 0` 会把空分母 error 门误判 PASS）。
- 报告新增 `scoring` 块：`raw_totals`（全量）、`scored_totals`（计分）、`excluded_images`（含排除原因），`per_image` 增 `allow_auto_import`/`correct_reject`；controller/page/auto_import_ratio 仍在全量上如实报告。
- `controller/page` 分类与 `auto_import_ratio` 口径不变，ZizES/TACT 既有报告语义不受排除逻辑影响（无负样本 → rejection N/A）。

**聚焦检查**：`scripts/check_023_rejection_scoring.py`（新增，17 项合成断言全过），关键证据：错误放行负样本仍计入分母（numeric 被拉低至 0.75、error 门与 rejection 门同时 FAIL、poc_pass=False）——不能靠排除分母获得 PASS。

## 交付 2：B_AND_R rank12 第 4 列关联错位根因修复（`scripts/extract_fields.py`）

- **根因**：第 4 列实际温度被 CLAHE 误读为 `2752`（小数点丢失，超出全部行值域）。旧对齐把「越界罚」挂在正确对齐上（1.0g），高于错位对齐的「未分配罚」（0.5g），于是整列上移一行（set←高温偏差 40、low←输出 1.0、control 缺格）。
- **修复**（仅 `extract_temperature_b_and_r` 的 `align_column`，净行数零增长）：行值域由软罚改为**硬约束**——token 只能落入数值在其行值域内的行；对任何行都越界的误读（2752）不可分配。正确与错位对齐在评分上不再倒挂。
- **结果**：rank12 col4 `set=275.0 / high=40.0 / low=40.0 / control=1.0` 全部与真值一致；`current` 因 OCR 误读 2752 缺格（`CELL_MISSING(current,col4)`，已知限制，status=review 拦截）。不匹配 3→1。
- **边界**：其余 6 张 B_AND_R fields/status 零 diff（warnings 仅 COLUMN_SHIFTED 单位显示修正）；列偏移证据链完整（col3-col6 依次 +0.50g/+0.65g/+0.80g/+0.95g，与透视畸变一致）。

## 停止事项：KEBA rank20/rank03 单值区（无法局部修复，交审批）

两路 OCR（基础 + CLAHE）token 全景与原图复核证据：

| 问题 | 证据 | 结论 |
|---|---|---|
| rank20 `holding` 180 漏提 | 两路 OCR 均未检出待机温度行的值；唯一候选 `'10'`(x=0.814, conf 0.51) 越出 holding 值域 [50,300] | OCR 检测层漏检，提取侧无 token 可关联 |
| rank20 `drop_port` 48→49 | 基础 OCR `'49'`(conf 1.00) 与 CLAHE `'49'`(conf 0.99) 一致高置信；原图 720×1280 重度倾斜模糊，人眼复核无法确证 48 或 49 | OCR 识别层误读；无三方一致证据不改真值（020 S1 先例），输出 48 只能是答案特判（PLAN 禁止） |
| rank03 `drop_port` 58 漏提 | 基础 OCR 下料口区无 token，CLAHE 仅 `'m'`(conf 0.61) | OCR 检测层漏检 |

按 PLAN §2「若两处根因无法在现有家族函数内以局部替换完成，S1 停止并报告」与 §4 停止条件，**不进入 S2**。可行修复方向（检测分辨率 `det_limit_side_len`、新 OCR 变体、VLM）均超出本 PLAN scope_out，且 `det_limit_side_len` 调整在 016 HANDOVER 已明确「会变动 ZizES 既有 OCR 基础，留待用户决策」。

## 家族边界与回归证据

- KEBA 13 图提取重跑与既有产物**零 diff**（status/fields/warnings 全等）——KEBA 路径代码未改。
- ZizES 21 份提取重跑**零 diff**；TACT 提取路径未触碰。
- B_AND_R 20 图范围内仅 rank12 fields 变化（改善）。
- 未生成、未替换最终 20 图验收报告（`output/bole_calib/accuracy_report*.json` 保持 020 S2 状态）。

## 修改文件

| 文件 | 改动 |
|---|---|
| `scripts/verify_accuracy.py` | v1.1 拒识计分口径 + rejection_accuracy + 空分母语义修正 + scoring 审计块 |
| `scripts/check_023_rejection_scoring.py` | 新增：17 项口径合成聚焦检查（可重复运行） |
| `scripts/extract_fields.py` | `align_column` 行值域硬约束（净行数零增长）+ COLUMN_SHIFTED 单位显示修正 |
| `docs/023_PLAN_20260801_伯乐S3拒识口径与定向收口.md` | frontmatter：doc_status in_progress、next_action await_acceptance；移除 S1 启动 Prompt 块（终止动作不得携带 Prompt） |
| `docs/024_HANDOVER_20260801_S1拒识口径与B&R列修复_KEBA根因交审批.md` | 本 HANDOVER（新增） |

未改模板、OCR 参数、KEBA/TACT/ZizES 提取路径；未重跑 OCR；未生成最终验收报告；既有未提交改动全部保留。

## S2 一次性验收入口（待审批决定是否启用）

若审批接受 KEBA 三项残留：冻结本切片的口径与提取实现，按 023 S2 跑一次现有 20 图完整链路。可预期的口径效果（供审批参考，非验收结论）：rank16 的 18 个元素排除计分后 KEBA 分母 294；残留 KEBA 3 个 + B_AND_R rank12 current 缺格 1 个不匹配将如实出现在报告中；`rejection_accuracy` 分母为 1。若审批要求先解决 KEBA 根因，则需就 OCR 层手段（分辨率/变体/VLM）单独决策。
