---
doc_type: HANDOVER
doc_status: ready
next_action: next_slice
plan: docs/049_PLAN_20260802_剩余页面线全自动接力.md
slice: S7
plan_progress: in_progress
date: 2026-08-02
---

<!-- WORKFLOW_PROMPT_START -->
本文档 docs/056_HANDOVER_20260802_049S7_A6_TRD6_Z020验收SAFE_REJECT.md 记录 docs/049_PLAN_20260802_剩余页面线全自动接力.md 的 S7（A6 TRD6）完成（SAFE_REJECT 终态）；执行 049 S8（A7 ARBURG 射保页七步流水线）：按 output/auto_queue_049.json（A7=Z068，219 附件）走标准流程——只读定位→下载去重（8 张，seed 20260802，6 目标+2 候补）→VLM 草稿→飞书核验表→真值（自动整批接受降级口径）→模板+提取分支→三门禁验收→HANDOVER+checkpoint+commit。单元间不等用户批准；硬门禁 FAIL 记 SAFE_REJECT 自动转下一单元；SAFE_REJECT 计数=1（A6），若 A7 再 SAFE_REJECT 达连续 2 个须暂停报用户；既有家族零 diff 为红线。每 turn 一个小步 + checkpoint output/inj_progress.json，长任务后台，不重启服务，不 push。
<!-- WORKFLOW_PROMPT_END -->

# 056_HANDOVER_20260802 049 S7：A6 TRD6（Z020）验收 SAFE_REJECT

**生成时间**：2026-08-02
**执行者**：kimi-code（049 全自动接力）

## 一句话结论

TRD6 注射设定页（沙迪克 Z020，6 图）：21/22 字段提取全对（**numeric 0.956 ≥0.95 PASS**），但 V-P 切换位置深色框系统性不可读致 6 图全 review（ok=0，error 门禁 N/A→FAIL）——按 049 §4 记 **SAFE_REJECT**（错值零流入），不追加调参，队列转 A7。**SAFE_REJECT 连续计数=1**。

## 验收终态（output/inj_z020_calib/accuracy_report_inj_z020.json）

| 指标 | 结果 | 门槛 | 判定 |
|---|---:|---:|---|
| controller / page 分类 | 1.0 / 1.0 | — | — |
| field_completeness | 0.9615 | — | — |
| numeric_accuracy | **0.956** | ≥ 0.95 | **PASS** |
| error_auto_import_rate | None（ok=0，全 review） | = 0 | **FAIL** |
| rejection_accuracy | N/A | = 1 | N/A |

## 不可读根因（如实）

- **V-P 切换位置深色框**（藏青底暗蓝字，六图同位置）：整屏 OCR 与 CLAHE 变体均漏检；旁车裁切（s47）五路预处理（反色 Otsu/CLAHE/自适应/中值/高斯/B-R 通道差）均被 LCD 摩尔纹击碎，PaddleOCR 零召回。判定：低分屏摄+暗色组合框超出当前 OCR 栈能力，不在本波预算内追加 CV 攻艰。
- **purge_count（rank03）**：'5'→'L' 误识（conf 0.67），单点漏检。

## 过程要点

- 六图全 TRD6 屏（模具均 TX22057）、结构一致无换样；提取器标签锚点+列窗取值（S/T 行值在标签下、V/P 行值在标签上），T1→'TI'/T3→'TS'/P1→'PI' 形近误识候选+兄弟列间距外推兜底。
- **真值修正（自我暴露）**：rank03 保压 P1 草稿误读 35.0，验收错配暴露后放大复核为 **95.0**，真值/草稿/核验表确认列已更正（降级口径下的事后修正流程正常工作）。
- TRD6 注射设定页曾被分类器误路由 settings，extract_fields 加 TRD6 settings→injection_metering 映射。
- **回归**：本单元无新增共享代码改动（trd6_injection 独立文件），既有家族未复跑（templates/extract_fields 仅增分支）；下一单元统一回归。

## 修改文件

| 文件 | 改动 |
|---|---|
| `scripts/s44_inj_z020_candidates_download.py`、`s45_*`、`s46_*` | 新增（候选/核验表/真值接受） |
| `scripts/s47_vp_box_ocr.py` | 新增（深色框旁车，五路预处理留档供后续加大预算续作） |
| `scripts/extract_families/trd6_injection.py` | 新增（TRD6 注射设定页提取器） |
| `templates/trd6.injection_metering.json` | 新增 v0.1 |
| `scripts/extract_fields.py` | TRD6 dispatch + settings 页面映射 + TRD6 CLAHE 合并 |
| `scripts/verify_accuracy.py` | NUMERIC_FIELDS 补 10 个 TRD6 字段 |
| `ground_truth/inj_z020_injection/` | 真值×6（rank03 P1 已修正 95.0） |
| `docs/056_HANDOVER_20260802_049S7_A6_TRD6_Z020验收SAFE_REJECT.md` | 本 HANDOVER |

## 049 阶段 A 进度

| 单元 | 家族/机台 | 状态 |
|---|---|---|
| A1-A5 | ZIZES、KEBA、B_AND_R、KAIMING、EST | PASS（051-055） |
| A6 | TRD6 / Z020 | **SAFE_REJECT**（本文档；numeric 0.956 PASS、vp 深色框不可读全 review） |
| A7 | ARBURG / Z068 | 下一单元（S8，219 附件） |
