---
doc_type: HANDOVER
doc_status: ready
next_action: none
plan: docs/029_PLAN_20260801_UNKNOWN机台家族裁定.md
slice: S4
plan_progress: complete
date: 2026-08-01
---

# 030_HANDOVER_20260801 UNKNOWN 机台家族裁定完成

**生成时间**：2026-08-01
**执行者**：kimi-code（自动模式 027 §3；S3 裁定表为唯一人工门）

## 一句话结论

32 台 UNKNOWN 机台全部完成家族裁定并回写档案，`machine_labels.json` 19→51 台；029 四切片（S1 下载→S2 判族→S3 裁定表→S4 回写）全部完成。

## 裁定结果（用户整批确认，1 台更正）

| 家族 | 台数 | 机台 |
|---|---:|---|
| B_AND_R | 12 | 伯乐 Z007/010/038/049/050/053/055/056/057/058/059/061 |
| TACT | 11 | 日精 Z009/011/012/014/015/016/019/025/077/078、伯乐 Z023 |
| FANUC | 4 | 发那科 Z027/035/036、伯乐 Z029 |
| KEBA | 2 | 伯乐 Z031/034（Z047 子变体） |
| DEMAG | 2 | 日精 Z003/008（Sumitomo SHI DEMAG 机，名册记日精） |
| EST | 1 | 伯乐 Z048（青绿 UI，伯乐 EST 控制器——用户书面更正，非五家族，暂不归档模板） |

- 用户确认 VLM 判断：Z023=TACT、Z029=FANUC、Z003/008=DEMAG。
- 「禁止按品牌推断」规则被验证必要：17 台伯乐里 4 台非 KEBA/B_AND_R，12 台日精里 2 台是 DEMAG。

## 切片记录

- S1：32/32 代表图下载零失败（`docs/samples_unknown/`、`output/unknown_sample_manifest.json`）。
- S2：VLM 判族 `output/unknown_family_drafts.json`（初判 OTHER×1，其余与终裁一致）。
- S3：飞书「UNKNOWN机台家族裁定」`tblBxWeEE5Y0Cq1Z` 32 行 + 代表图；用户整批裁定（Z048 OTHER→EST，Z003/008 标记确认 DEMAG）。
- S4：`machine_labels.json` 回写 32 条（证据=代表图+飞书裁定，verified_by=用户本人，verified_at=2026-08-01）。

## 后续（未启动，交用户决定）

- 扩池候选：发那科 Z036（474 条 FANUC）、日精 TACT 10 台、伯乐 B_AND_R 12 台——各家族真值/模板扩样可另立 PLAN（FANUC/DEMAG 验收口径沿 026 现态：numeric ~0.91 未达 0.95）。
- EST（Z048）若需建模板另立项。

## 修改文件

| 文件 | 改动 |
|---|---|
| `ground_truth/machine_labels.json` | +32 台（19→51） |
| `scripts/s12_unknown_sample_download.py`、`s13_build_unknown_verify_table.py` | 新增 |
| `docs/samples_unknown/` ×32、`output/unknown_*`（manifest/drafts/verify_table_records/progress） | 切片产物 |
| `docs/029_PLAN_20260801_UNKNOWN机台家族裁定.md` | frontmatter → completed |
| `docs/030_HANDOVER_20260801_UNKNOWN机台家族裁定完成.md` | 本 HANDOVER |
