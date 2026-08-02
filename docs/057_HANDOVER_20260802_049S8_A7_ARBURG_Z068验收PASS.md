---
doc_type: HANDOVER
doc_status: ready
next_action: next_slice
plan: docs/049_PLAN_20260802_剩余页面线全自动接力.md
slice: S8
plan_progress: in_progress
date: 2026-08-02
---

<!-- WORKFLOW_PROMPT_START -->
本文档 docs/057_HANDOVER_20260802_049S8_A7_ARBURG_Z068验收PASS.md 记录 docs/049_PLAN_20260802_剩余页面线全自动接力.md 的 S8（A7 ARBURG）完成（PASS，SAFE_REJECT 连续计数清零）；执行 049 S9（B1 储料/冷却页面线首机七步流水线）：按 output/auto_queue_049.json 阶段 B 选机走标准流程——只读定位→下载去重（8 张，seed 20260802，6 目标+2 候补）→VLM 草稿→飞书核验表→真值（自动整批接受降级口径）→模板+提取分支→三门禁验收→HANDOVER+checkpoint+commit。单元间不等用户批准；硬门禁 FAIL 记 SAFE_REJECT 自动转下一单元，连续 2 个 SAFE_REJECT 暂停报用户；既有家族零 diff 为红线。每 turn 一个小步 + checkpoint output/inj_progress.json，长任务后台，不重启服务，不 push。
<!-- WORKFLOW_PROMPT_END -->

# 057_HANDOVER_20260802 049 S8：A7 ARBURG（Z068）验收 PASS

**生成时间**：2026-08-02
**执行者**：kimi-code（049 全自动接力）

## 一句话结论

ARBURG SELOGICA 注射页（阿博格 Z068，6 图）**numeric 1.0 / error 0 / 6 图全 ok 三门禁 PASS**——阶段 A 以 6/7 单元 PASS 收官（TRD6 SAFE_REJECT），SAFE_REJECT 连续计数清零，队列转阶段 B 页面线。

## 验收终态（output/inj_z068_calib/accuracy_report_inj_z068.json）

| 指标 | 结果 | 门槛 | 判定 |
|---|---:|---:|---|
| controller / page 分类 | 1.0 / 1.0 | — | — |
| field_completeness | 1.0 | — | — |
| numeric_accuracy | **1.0（6 图全元素）** | ≥ 0.95 | **PASS** |
| error_auto_import_rate | **0.0** | = 0 | **PASS** |
| auto_import_ratio | 1.0（6/6 ok） | — | — |

## 过程要点（本单元曾濒临 SAFE_REJECT，四轮修正救回）

- **换样**：原 rank04（vivo 模糊照）管线质量拒识；候补 rank07 为温度页混入（大表附件错字段）剔除；候补 rank08 清晰注射页换入（同 rank02 参数体系）。
- **页结构**：段表 v mm/s / p bar / s mm（**段1 在最右**，左侧当前值列与绿字实际列排除，行内取最右 3 值倒置）；进料位=「进料位」标签右侧蓝框（顶部仪表小数/周期秒易误抢，须标签锚定+dx 0.40）；转压位=末段 s；注射结束（转压）用=行程。
- **关键修复**：行尾单位 token 锚行（'mm'/'mrmi'、'mm/s'/'mmfs' 变体 + 图表轴同名单位按行内有效值数择优）；**延迟时间灰框旁车（s51 ocr_delay.json）**——整屏 OCR 对该小灰框零召回，裁切 3x 后 6 图 '0.00' 全部 conf~1.0 召回（此修复把本单元从全 review 救回）。
- ARBURG 注射页含曲线图被分类器记 monitor_curve/unknown，extract_fields 加映射；family_detect_groups 零碰撞。
- **回归**：9 家族（z017/z022/z002/z036/z031/z050/z062/z048/z020）零 diff（z022 仅 family_source provenance）。

## 修改文件

| 文件 | 改动 |
|---|---|
| `scripts/s48_inj_z068_candidates_download.py`、`s49_*`、`s50_*` | 新增（候选/核验表/真值接受） |
| `scripts/s51_delay_box_ocr.py` | 新增（延迟时间灰框旁车） |
| `scripts/extract_families/arburg_injection.py` | 新增（ARBURG 注射页提取器） |
| `templates/arburg.injection_metering.json` | 新增 v0.1 |
| `scripts/extract_fields.py` | ARBURG dispatch + monitor_curve/unknown 页面映射 + ocr_delay 旁车并入 |
| `ground_truth/inj_z068_injection/`、`output/inj_z068_*`、`docs/samples_inj_z068/` | 真值×6、产物、样本（含换样留档 inj_z068_rejected/） |
| `docs/057_HANDOVER_20260802_049S8_A7_ARBURG_Z068验收PASS.md` | 本 HANDOVER |

## 049 阶段 A 终态（7/7 单元闭合）

| 单元 | 家族/机台 | 状态 |
|---|---|---|
| A1-A5 | ZIZES、KEBA、B_AND_R、KAIMING、EST | PASS（051-055） |
| A6 | TRD6 / Z020 | SAFE_REJECT（056：numeric 0.956 PASS、vp 深色框不可读全 review） |
| A7 | ARBURG / Z068 | **PASS**（本文档） |

**下一步**：阶段 B 五条页面线（B1 储料/冷却 → B5 模温机）首机开辟。
