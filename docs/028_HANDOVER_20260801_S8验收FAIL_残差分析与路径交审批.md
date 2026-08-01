---
doc_type: HANDOVER
doc_status: ready
next_action: await_acceptance
plan: docs/026_PLAN_20260801_FANUC与DEMAG温度页模板细分执行.md
slice: S8
plan_progress: in_progress
date: 2026-08-01
---

# 028_HANDOVER_20260801 S8 验收 FAIL：残差分析与路径交审批

**生成时间**：2026-08-01
**执行者**：kimi-code（实施阶段执行者，自动模式 027 §3）
**验收口径**：026 PLAN S8——冻结 S7 实现，复用缓存 OCR（基础+CLAHE+zoom/HSV 旁车），提取+真值比对跑一次，看过结果未再调参

## 一句话结论

三门禁 **1 PASS（error=0）、1 FAIL（numeric 0.8747 < 0.95）、1 N/A（rejection 无负样本分母）**，026 判定 **FAIL**；分类双 1.0、完整率 0.8993、既有家族零退化。残差 56 个不匹配的根因已分类定位，**即便行逻辑完美，OCR 物理层残差也使 0.95 不可达（估计上限 ~0.91）**，路径选择交用户审批。

## 验收结果（output/fanuc_demag_calib/accuracy_report_fanuc_demag_calib.json）

| 指标 | 结果 | 门槛 | 判定 |
|---|---:|---:|---|
| controller_classification_accuracy | 1.0（18/18） | — | — |
| page_classification_accuracy | 1.0（18/18） | — | — |
| field_completeness | 0.8993（402/447） | — | — |
| numeric_accuracy | **0.8747（391/447）** | ≥ 0.95 | **FAIL** |
| auto_import_ratio | 0.1111（2/18） | — | — |
| error_auto_import_rate | **0.0（0/52）** | = 0 | **PASS** |
| rejection_accuracy | N/A（负样本分母 0） | = 1 | N/A（不宣称 PASS） |

分家族：FANUC 0.9097（131/144，完整率 0.9653）、DEMAG 0.8581（260/303，完整率 0.8680）。明细：`accuracy_report_fanuc_demag_by_family.json`。

## 残差分类（56 个不匹配）

### A. rank07 运动模糊整图（17 个）——口径问题，交审批 ①

原图运动模糊，行标签与多列数值经原生分辨率放大仍不可读（真值阶段已按纪律将不可读字段置 null，保留 17 个可读真值字段）。提取侧 OCR 检测层无 token 可关联，`ROW_ANCHORS_NOT_FOUND` 拒提（status=reject，安全行为）。但真值 `allow_auto_import=true`，17 个字段全部计入分母。
**若改判 `allow_auto_import=false`（伯乐 rank16 报警图先例），rejection 门生效（1/1），计分 numeric 升至 ~0.909——仍不达 0.95。** 真值修改权属用户（020 S1 先例），未擅动。

### B. OCR 物理层误读（~15 个）——手段问题，交审批 ②

- 符号丢失：`-14→14`、`-41→41`（HSV 单格已大幅召回速率，个别负号仍丢）
- 截读：`17→1`、`24→2`、`18.2→16.2`（rank02 暗图）
- 固定误读：rank01 下料口输出 `31.0→31.8`（两路 OCR 一致误读，同伯乐 48→49 类）
- 恶性粘连：`13-5985`（13.5+98.5 丢点融合，局部不可拆分）

此类在 024 已定性「OCR 层失败，家族函数内不可局部修复」；可行手段（提高 `det_limit_side_len`、更多图像变体、VLM fallback）均超出 026 scope_out，且 016/020 明确留待用户决策。

### C. 结构性单格缺漏（~24 个）——可继续收敛但收益见顶

DEMAG 喷嘴列（rank09/11/12 列位实测缺列回退模板后单格未吸附）、偏差行单格、油块标签变体；FANUC rank05 输出行粘连。逐一修复估计还可挽回 10-15 个，但叠加 B 类下限后 **numeric 天花板约 0.91-0.92，仍低于 0.95**。

## 安全面与回归证据

- `error_auto_import_rate = 0` 全程成立：所有不确定值走 null+warning（review），ok 图（rank10/rank15）零错值；「宁可缺不可错」原则在 FANUC/DEMAG 路径生效。
- 既有家族零退化：伯乐 20 / TACT 6 / ZizES 21 提取重跑与既有产物**全等**（extract_fields.py 大改后复验）。
- `extract_fields.py` 1158→734 行，KEBA/B_AND_R/FANUC/DEMAG 家族提取器均入 `scripts/extract_families/`，合同大文件线合规。

## 交审批的三条路径

1. **rank07 口径**：真值 `allow_auto_import` 改判 false（rejection 门生效，numeric 至 ~0.909）——是否批准？
2. **OCR 层手段**：是否批准提高检测分辨率/新增变体/重议 VLM fallback 以攻 B 类残差（预计可再救 ~10 个，但 0.95 仍需 C 类同步收敛）？
3. **接受 FAIL**：013 S4 挂起不收口，FANUC/DEMAG 模板与提取器保留现状（分类可用、提取 review 主导、零误入库），后续视生产需要再立项。

## 修改文件

| 文件 | 改动 |
|---|---|
| `scripts/extract_families/{__init__,common,keba,b_and_r,fanuc,demag}.py` | 新增（keba/b_and_r 为拆出） |
| `scripts/extract_fields.py` | 1158→734 行；拆出家族提取器；FANUC/DEMAG 接线 + zoom/HSV 旁车合并 |
| `scripts/s4_fanuc_demag_pool_inventory.py`、`s4_download_fanuc_demag.py`、`s5_build_fanuc_demag_verify_table.py`、`s6_fanuc_demag_truth_accept.py`、`s7_fanuc_template_calib.py`、`s8_demag_template_calib.py`、`s9_demag_rate_strip_ocr.py`、`s10_fanuc_zoom_ocr.py`、`s11_demag_rate_cells.py` | 026 各切片新增脚本 |
| `templates/{fanuc,demag}.temperature.json` | v0.1.0（碰撞检查零碰撞） |
| `ground_truth/machine_labels.json` | 补 demag_Z002/Z005、fanuc_Z032 路由先验 |
| `ground_truth/fanuc_demag_temperature/` ×18 | 真值（自动整批接受，降级标注） |
| `output/fanuc_demag_*`（manifest/candidates/verify_table_records/drafts/calib 全套） | 切片产物 |
| 飞书 `tbl83A65O5OAPhyU` | 核验表 18 行+原图+确认列回填 |
| `docs/028_HANDOVER_20260801_S8验收FAIL_残差分析与路径交审批.md` | 本 HANDOVER |

## 013 衔接

- 013 S4（FANUC/DEMAG）**验收 FAIL，不收口**；013 保持 in_progress，S4 状态待用户按上述三条路径裁定后更新。
- 未启动其他家族、未动生产链路；UNKNOWN 29 台机台继续挂起。
