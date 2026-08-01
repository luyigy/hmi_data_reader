---
doc_type: HANDOVER
doc_status: ready
next_action: await_acceptance
plan: docs/031_PLAN_20260801_TACT第一波扩样.md
slice: S6
plan_progress: in_progress
date: 2026-08-01
---

# 033_HANDOVER_20260801 TACT 模板参数化整改，设定行检测层残余交审批

**生成时间**：2026-08-01
**执行者**：kimi-code（自动模式 027 §3；整改路径经用户「继续」批准）

## 一句话结论

参数化整改把 TACT 提取从"单机五段硬锚"变为"段头标签动态定位"，复验 numeric 0.4884→0.8179、Z019 全对、Z022 零 diff；0.95 未达，残余为设定行红框 OCR 检测层缺失，路径交审批。

## 整改内容（`scripts/extract_fields.py` 的 `extract_temperature_tact`）

| 改动 | 效果 |
|---|---|
| 段数变体自适应：中间段（筒头）整列不存在时按实际段数提取 | 四段机（Z015/Z019）不再错位，Z019 六图全对 |
| 边缘段列头缺失按实测列距中位数外推 | 替代错误的五段模板坐标回退 |
| 设定行 HSV 红框旁车（`.ocr_setrow.json`，`scripts/s18_tact_setrow_cells.py`）+ 定点补格 | 部分召回基础/CLAHE 整行漏检的红框设定值 |
| 值域护栏（料筒 [100,450]、落下口 [10,120]）+ 4 位无点 /10 还原 | 防图形杂值（'32'/'700'）误吸附、修 OCR 丢点（2718→271.8） |

## 复验对比（同批 18 真值，两次冻结跑分）

| 指标 | 整改前（032） | 整改后（033） |
|---|---:|---:|
| numeric_accuracy | 0.4884 | **0.8179** |
| field_completeness | 0.6676 | 0.8497 |
| controller / page | 1.0 / 0.9444 | 1.0 / 0.9444 |
| error_auto_import_rate | 空分母（无 ok 图） | 空分母（无 ok 图，零误放行） |
| Z022 回归 | — | **零 diff** |

## 残余（~60 个不匹配）

1. **设定行红框检测层缺失（主因，~45 个）**：多张图的设定温度行（红渐变框）基础+CLAHE 两路 OCR 整行检测不到；HSV 旁车对该行只部分召回（红框相连轮廓、杂图形干扰）。属 024 定性的「OCR 层失败」同类，可行手段（`det_limit_side_len`、更多图像变体）在 016 已留用户决策。
2. **rank14 页面误判 monitor_curve（1 张）**：该图行标签反光缺失，模板锚点未命中后 find_page 误分类，NO_TEMPLATE 拒提。
3. 零星单元格漏检（斜拍反光）。

## 路径交审批

1. **继续攻检测层**：提高 OCR 检测分辨率/增加变体（会变动既有 OCR 基线，需先小实验证 ZizES 零退化）；
2. **接受现态挂起**：参数化成果已固化（四/五段自适应 + 边缘外推 + 护栏），TACT 扩样验收线停在 0.8179，后续样本自然受益。

## 修改文件

| 文件 | 改动 |
|---|---|
| `scripts/extract_fields.py` | `extract_temperature_tact` 参数化（变体自适应/边缘外推/旁车补格/护栏/丢点还原）+ TACT 旁车并入 |
| `scripts/s18_tact_setrow_cells.py` | 新增：设定行 HSV 旁车 |
| `output/tact_exp_calib/accuracy_report_tact_exp.json` | 复验报告（0.8179） |
| `output/tact_exp_calib/rectified/*.ocr_setrow.json` | 旁车产物 ×24（含 Z022 6 图，未改变其输出） |
| `docs/033_HANDOVER_20260801_TACT模板参数化整改_设定行检测层残余交审批.md` | 本 HANDOVER |

未改模板 JSON、真值、既有家族产物；Z022/bole/zizes/fanuc_demag 提取产物未触碰（Z022 零 diff 已验证，其余家族代码路径未改）。
