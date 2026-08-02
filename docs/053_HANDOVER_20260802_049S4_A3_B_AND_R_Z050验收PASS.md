---
doc_type: HANDOVER
doc_status: ready
next_action: next_slice
plan: docs/049_PLAN_20260802_剩余页面线全自动接力.md
slice: S4
plan_progress: in_progress
date: 2026-08-02
---

<!-- WORKFLOW_PROMPT_START -->
本文档 docs/053_HANDOVER_20260802_049S4_A3_B_AND_R_Z050验收PASS.md 记录 docs/049_PLAN_20260802_剩余页面线全自动接力.md 的 S4（A3 B_AND_R）完成；执行 049 S5（A4 KAIMING 射保页七步流水线）：按 output/auto_queue_049.json（A4=Z062，36 附件）走标准流程——只读定位→下载去重（8 张，seed 20260802，6 目标+2 候补）→VLM 草稿→飞书核验表→真值（自动整批接受降级口径）→模板+提取分支→三门禁验收→HANDOVER+checkpoint+commit。单元间不等用户批准；硬门禁 FAIL 记 SAFE_REJECT 自动转下一单元，连续 2 个 SAFE_REJECT 暂停报用户；既有家族（TACT/DEMAG/FANUC/ZIZES/KEBA/B_AND_R 射保、各温度家族）零 diff 为红线。每 turn 一个小步 + checkpoint output/inj_progress.json，长任务后台，不重启服务，不 push。
<!-- WORKFLOW_PROMPT_END -->

# 053_HANDOVER_20260802 049 S4：A3 B_AND_R（Z050）验收 PASS

**生成时间**：2026-08-02
**执行者**：kimi-code（049 全自动接力）

## 一句话结论

B&R 贝加莱射胶页（伯乐 Z050，6 图）模板+提取器首波 **numeric 1.0 / error 0 / 6 图全 ok 三门禁 PASS**，049 阶段 A 第三个单元收口（三连 PASS），队列自动转 A4 KAIMING。

## 验收终态（output/inj_z050_calib/accuracy_report_inj_z050.json）

| 指标 | 结果 | 门槛 | 判定 |
|---|---:|---:|---|
| controller / page 分类 | 1.0 / 1.0 | — | — |
| field_completeness | 1.0 | — | — |
| numeric_accuracy | **1.0（6 图全元素）** | ≥ 0.95 | **PASS** |
| error_auto_import_rate | **0.0** | = 0 | **PASS** |
| auto_import_ratio | 1.0（6/6 ok） | — | — |

## 过程要点

- 六图全为 B&R 贝加莱屏、结构一致，**无换样**（区别于 Z017/Z031 的混入图，本机 140 附件全去重后零异构）。
- **页结构**：射胶 5 段表（速度%/压力 bar/位置 mm，**段1在最右**，行内值按 x 降序=段1→段5；蓝字时间行=实际值跳过）+ 保压 5 段表（速度/压力/时间）+ 保压切换（位置 mm+时间 sec 勾选式，六图均「位置+时间」）。有效段：射胶=速度或压力非零最末段、保压=时间>0 最末段。
- **提取器踩坑**：段表行标签常被照片左缘裁切——弃标签锚定，改区段头（深色条标题，x 0.35~0.65，保压切换唯一→反向链式锚定 保压→射胶，免固定 y 窗）+ 区内值行 y 聚类序配对；段头裸数字（'1'..'5'）混入聚类须排除（本页值均 X.X 形态）；保压切换时间值 dx 0.261 超窗（0.25→0.30）。
- **核验表**：tblNT15qet0PklAf（6 行自动整批接受回填）；真值 `ground_truth/inj_z050_injection/`。
- **回归**：z017/z002/z036/z031 零 diff，z022 仅 family_source provenance（产物已恢复基线）；新模板 family_detect_groups 零碰撞。

## 修改文件

| 文件 | 改动 |
|---|---|
| `scripts/s35_inj_z050_candidates_download.py` | 新增 |
| `scripts/s36_build_inj_z050_verify_table.py` | 新增 |
| `scripts/s37_inj_z050_truth_accept.py` | 新增 |
| `scripts/extract_families/b_and_r_injection.py` | 新增（B&R 射胶页提取器） |
| `templates/b_and_r.injection_metering.json` | 新增 v0.1 |
| `scripts/extract_fields.py` | import + injection_metering/B_AND_R dispatch 分支 |
| `scripts/verify_accuracy.py` | NUMERIC_FIELDS 补 vp_switch_time_s |
| `ground_truth/inj_z050_injection/`、`output/inj_z050_*`、`docs/samples_inj_z050/` | 真值×6、产物、样本 |
| `docs/053_HANDOVER_20260802_049S4_A3_B_AND_R_Z050验收PASS.md` | 本 HANDOVER |

## 049 阶段 A 进度

| 单元 | 家族/机台 | 状态 |
|---|---|---|
| A1 | ZIZES / Z017 | PASS（051） |
| A2 | KEBA / Z031 | PASS（052） |
| A3 | B_AND_R / Z050 | **PASS**（本文档） |
| A4 | KAIMING / Z062 | 下一单元（S5，36 附件，首个无温度页模板家族） |
| A5-A7 | EST/Z048、TRD6/Z020、ARBURG/Z068 | 排队 |
