---
doc_type: HANDOVER
doc_status: ready
next_action: next_slice
plan: docs/049_PLAN_20260802_剩余页面线全自动接力.md
slice: S2
plan_progress: in_progress
date: 2026-08-02
---

<!-- WORKFLOW_PROMPT_START -->
本文档 docs/051_HANDOVER_20260802_049S2_A1_ZIZES_Z017验收PASS.md 记录 docs/049_PLAN_20260802_剩余页面线全自动接力.md 的 S2（A1 ZIZES）完成；执行 049 S3（A2 KEBA 射保页七步流水线）：按 output/auto_queue_049.json（A2=Z031，184 附件）走标准流程——只读定位→下载去重（8 张，seed 20260802，6 目标+2 候补）→VLM 草稿→飞书核验表→真值（自动整批接受降级口径）→模板+提取分支→三门禁验收→HANDOVER+checkpoint。单元间不等用户批准；硬门禁 FAIL 记 SAFE_REJECT 自动转下一单元，连续 2 个 SAFE_REJECT 暂停报用户；既有家族（TACT/DEMAG/FANUC/ZIZES 射保、各温度家族）零 diff 为红线。每 turn 一个小步 + checkpoint output/inj_progress.json，长任务后台，不重启服务，不 push。
<!-- WORKFLOW_PROMPT_END -->

# 051_HANDOVER_20260802 049 S2：A1 ZIZES（Z017）验收 PASS

**生成时间**：2026-08-02
**执行者**：kimi-code（049 全自动接力）

## 一句话结论

ZIZES 射出页（佳明 Z017，6 图）模板+提取器首波 **numeric 1.0 / error 0 三门禁 PASS**（5 ok + 1 review 安全态），049 阶段 A 首个单元收口，队列自动转 A2 KEBA。

## 验收终态（output/inj_z017_calib/accuracy_report_inj_z017.json）

| 指标 | 结果 | 门槛 | 判定 |
|---|---:|---:|---|
| controller / page 分类 | 1.0 / 1.0 | — | — |
| field_completeness | 1.0 | — | — |
| numeric_accuracy | **1.0（6 图全元素）** | ≥ 0.95 | **PASS** |
| error_auto_import_rate | **0.0** | = 0 | **PASS** |
| auto_import_ratio | 0.8333（5/6 ok；rank02 保压段数 OCR 漏检→STAGES_INFERRED 推断态置 review，推断值 2 段全对） | — | — |

## 过程要点

- **换样记录**：原 rank05 为 BOLE 贝加莱 BKS_230 屏混入大表 Z017 附件（同 Z019 先例），按候补固定顺序替换为 recuQJJQEdxw2h（2025-07-02），剔除图留档 `output/inj_z017_rejected/`。
- **页结构**：射出 6 段表（bar/%/mm 黑字设定，s 列红字实际）+ 右侧 射出时间/延时/段数；保压 ≤5 段（bar/%/s 黑字设定，红 s 实际）+ 保压切换（0=位置 1=时间 2=时间+位置）/保压段数；底部上限/下限。红字实时值一律不入。
- **提取器踩坑**：'射出三'→'出三' 丢首字（正则兜底）；'20=位置1=时间' 保压切换值与图例粘连（取首位数字+窗口放宽 dx0.30）；'160.0下限' 粘连切分（行带放宽 0.03）；段数 token 漏检按「连续满列前缀」推断并置 review 防错值入 ok。
- **核验表**：tblXuLLtZkfCYzbS（6 行已自动整批接受回填）；真值 `ground_truth/inj_z017_injection/`。
- **回归**：Z002/Z036 零 diff；Z022 仅 family_source provenance 差（早前 machine_labels 扩容，与本次无关，产物已恢复基线）；新模板 family_detect_groups 与既有 9 模板零碰撞。

## 修改文件

| 文件 | 改动 |
|---|---|
| `scripts/s29_inj_z017_candidates_download.py` | 新增（候选+下载） |
| `scripts/s30_build_inj_z017_verify_table.py` | 新增（核验表） |
| `scripts/s31_inj_z017_truth_accept.py` | 新增（自动整批接受转真值） |
| `scripts/extract_families/zizes_injection.py` | 新增（ZIZES 射出页提取器） |
| `templates/zizes.injection_metering.json` | 新增 v0.1 |
| `scripts/extract_fields.py` | import + injection_metering/ZIZES dispatch 分支 |
| `scripts/verify_accuracy.py` | NUMERIC_FIELDS 补 11 个 ZIZES 射保字段 |
| `ground_truth/inj_z017_injection/`、`output/inj_z017_*`、`docs/samples_inj_z017/` | 真值×6、产物、样本 |
| `docs/051_HANDOVER_20260802_049S2_A1_ZIZES_Z017验收PASS.md` | 本 HANDOVER |

## 049 阶段 A 进度

| 单元 | 家族/机台 | 状态 |
|---|---|---|
| A1 | ZIZES / Z017 | **PASS**（本文档） |
| A2 | KEBA / Z031 | 下一单元（S3） |
| A3-A7 | B_AND_R/Z050、KAIMING/Z062、EST/Z048、TRD6/Z020、ARBURG/Z068 | 排队 |
