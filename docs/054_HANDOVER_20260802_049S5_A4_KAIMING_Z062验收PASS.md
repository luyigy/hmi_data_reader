---
doc_type: HANDOVER
doc_status: ready
next_action: next_slice
plan: docs/049_PLAN_20260802_剩余页面线全自动接力.md
slice: S5
plan_progress: in_progress
date: 2026-08-02
---

<!-- WORKFLOW_PROMPT_START -->
本文档 docs/054_HANDOVER_20260802_049S5_A4_KAIMING_Z062验收PASS.md 记录 docs/049_PLAN_20260802_剩余页面线全自动接力.md 的 S5（A4 KAIMING）完成；执行 049 S6（A5 EST 射保页七步流水线）：按 output/auto_queue_049.json（A5=Z048）走标准流程——只读定位→下载去重（8 张，seed 20260802，6 目标+2 候补）→VLM 草稿→飞书核验表→真值（自动整批接受降级口径）→模板+提取分支→三门禁验收→HANDOVER+checkpoint+commit。单元间不等用户批准；硬门禁 FAIL 记 SAFE_REJECT 自动转下一单元，连续 2 个 SAFE_REJECT 暂停报用户；既有家族（TACT/DEMAG/FANUC/ZIZES/KEBA/B_AND_R/KAIMING 射保、各温度家族）零 diff 为红线。每 turn 一个小步 + checkpoint output/inj_progress.json，长任务后台，不重启服务，不 push。
<!-- WORKFLOW_PROMPT_END -->

# 054_HANDOVER_20260802 049 S5：A4 KAIMING（Z062）验收 PASS

**生成时间**：2026-08-02
**执行者**：kimi-code（049 全自动接力）

## 一句话结论

KAIMING 开明射出页（佳明 Z062，6 图）模板+提取器首波 **numeric 1.0 / error 0 / 6 图全 ok 三门禁 PASS**——首个无温度页对照模板的新家族一次通过，049 阶段 A 四连 PASS，队列自动转 A5 EST。

## 验收终态（output/inj_z062_calib/accuracy_report_inj_z062.json）

| 指标 | 结果 | 门槛 | 判定 |
|---|---:|---:|---|
| controller / page 分类 | 1.0 / 1.0 | — | — |
| field_completeness | 1.0 | — | — |
| numeric_accuracy | **1.0（6 图全元素）** | ≥ 0.95 | **PASS** |
| error_auto_import_rate | **0.0** | = 0 | **PASS** |
| auto_import_ratio | 1.0（6/6 ok） | — | — |

## 过程要点

- 六图全 KAIMING 屏、结构一致无换样（其中 rank03/06 为 RENYE 机身+开明控制器，控制器家族判定不受影响）。
- **页结构**：射出 6 段表（压力 Bar/速度 %/位置 mm，一段在最右；灰底时间行=实际值跳过）+ 转保压（位置｜压力，六图均选位置；位置 mm+时间 sec）+ 保压 5 段表（压力/速度/时间），有效段=时间>0 最末段（rank03 保压 3 段，其余 2 段）；三段射出位置空白记 0.0。
- **提取器踩坑**：行标签竖排 OCR 合并（'压速时位'）弃用标签锚定，改区段锚点（转保压/射出位置）+ 值行聚类序配对；位置行与压力行列 x 错位 0.07，按列中心归段会错号，必须行内 x 降序归段；'转保压'常与'位置'粘成 '转保压位置'（子串锚定）；转保压值行（1.30 等）须排除在保压表区外；machine_labels 补 inj_Z062 路由别名。
- **核验表**：6 行自动整批接受回填；真值 `ground_truth/inj_z062_injection/`。
- **回归**：z017/z002/z036/z031/z050 零 diff，z022 仅 family_source provenance（产物已恢复基线）。

## 修改文件

| 文件 | 改动 |
|---|---|
| `scripts/s38_inj_z062_candidates_download.py` | 新增 |
| `scripts/s39_build_inj_z062_verify_table.py` | 新增 |
| `scripts/s40_inj_z062_truth_accept.py` | 新增 |
| `scripts/extract_families/kaiming_injection.py` | 新增（KAIMING 射出页提取器） |
| `templates/kaiming.injection_metering.json` | 新增 v0.1 |
| `scripts/extract_fields.py` | import + injection_metering/KAIMING dispatch 分支 |
| `ground_truth/machine_labels.json` | inj_Z062_KAIMING 路由别名 |
| `ground_truth/inj_z062_injection/`、`output/inj_z062_*`、`docs/samples_inj_z062/` | 真值×6、产物、样本 |
| `docs/054_HANDOVER_20260802_049S5_A4_KAIMING_Z062验收PASS.md` | 本 HANDOVER |

## 049 阶段 A 进度

| 单元 | 家族/机台 | 状态 |
|---|---|---|
| A1-A3 | ZIZES/Z017、KEBA/Z031、B_AND_R/Z050 | PASS（051/052/053） |
| A4 | KAIMING / Z062 | **PASS**（本文档） |
| A5 | EST / Z048 | 下一单元（S6） |
| A6-A7 | TRD6/Z020、ARBURG/Z068 | 排队 |
