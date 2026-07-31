---
doc_type: HANDOVER
doc_status: ready
plan: docs/015_PLAN_20260731_TACT温度页模板校准与链路验收.md
slice: S1
plan_progress: in_progress
next_action: next_slice
date: 2026-07-31
---

<!-- WORKFLOW_PROMPT_START -->
本文档 docs/016_HANDOVER_20260731_TACT温度页模板与最小链路支持.md 记录 docs/015_PLAN_20260731_TACT温度页模板校准与链路验收.md 的 S1（TACT 温度页归一化模板 + 最小提取/验证支持）完成情况：模板已用 6 份用户确认真值校准，TACT 特有字段全部进入提取与六指标分母，五项聚焦检查通过。
下一步执行 015 PLAN 的 S2：仅对已核验的 6 张 Z022/A06 图片跑一次完整链路并产出六项指标报告。硬约束不变：不授予生产自动入库权限，不把 4 张候补混入验收分母。
<!-- WORKFLOW_PROMPT_END -->

# 016_HANDOVER_20260731_S1 TACT 温度页模板与最小链路支持

**生成时间**：2026-07-31
**基线 commit**：`f60fa1b`（开工时 HEAD；本切片代码/模板改动尚未提交，见「改动文件」）

---

## 一句话结论

S1 完成：`templates/tact.temperature.json` 已基于 6 份用户整批确认真值图校准（rectify 屏幕归一化坐标）；`extract_fields.py` / `verify_accuracy.py` 最小扩展使 TACT 特有字段（保温温度 ×5、落下口设定/当前/控制）确实被提取并全部计入六指标分母（138/138 元素）；五项聚焦检查全部通过，ZizES 零退化。停止条件达成，未跑六图完整链路、未生成最终六指标报告。

## 输入确认（按 015 PLAN 视为已完成事实）

- 直接接受 `ground_truth/tact_temperature/` 6 份真值（`changed_fields=0`，用户 2026-07-31 Live Room 整批确认，降级口径保留在真值备注中），未重建飞书核验表、未要求逐字段重贴、未下载新附件。
- 开工时工作区全部既有未提交改动原样保留；本切片改动叠加其上，未做任何回退。

## 改动文件

| 文件 | 改动 |
|---|---|
| `templates/tact.temperature.json` | **新增** v0.1.0。TACT 温度页（5 段料筒 喷嘴/筒头/前部/中部/后部 + 落下口独立列；设定/现在/控制/保温 4 行）归一化坐标模板：6 张真值图 rectify 四角矫正 + PaddleOCR 实测 10 个锚点（6 区段列头 + 4 行标签）算术平均；声明 `page_detect_anchors`、`zone_labels`、`drop_port_label`；校验规则与 ZizES 模板同口径（温度 0-450、控制 0-100、current vs set ±5°C、min_cell_conf 0.85） |
| `scripts/extract_fields.py` | 最小扩展三处：①`route_page` 页面检测锚点改为模板可声明（`page_detect_anchors`），缺省保持 ZizES 原口径不变；②新增 `extract_temperature_tact`（区段中文列头实测列位 + 行标签直接锚定 4 行 + 落下口三字段，复用 norm_tokens/去斜/单元格/范围/一致性校验，无新抽象层）；③`extract_one` 按模板 `ui_family=="TACT"` 分派。模块 docstring 同步更新 |
| `scripts/verify_accuracy.py` | `NUMERIC_FIELDS` 增加 `holding_temperature_c`、`drop_port_temperature_set_c/current_c/control_percent`（家族间并集，不属于该家族真值的字段读出为 None 不进分母）；新增 `truth_numeric_keys` + **漏算硬检查**：真值含 NUMERIC_FIELDS 之外的数值字段时直接失败退出，防止 TACT 字段再次被漏出分母形成假高分（即 015 PLAN 要求保留的最小自动检查） |
| `output/tact_calib/` | 校准工作区（gitignored 类产物）：6 张图 rectify meta + OCR JSON + 提取结果 + 校准用比对报告 `accuracy_report_tact_calib.json` |

**环境备注**：原 `.venv` 的 uv 解释器缺失（014 已记录），本切片将 paddlepaddle 2.6.2 + paddleocr 2.7.3 + numpy<2 装入 `.venv-s1/`（不进 git），OCR 模型缓存于 `~/.paddleocr/`（不进 git）。OCR 参数与链路默认完全一致，未改 `ocr_one.py`。

## 聚焦验证结果（015 PLAN S1 第 4 条）

1. **模板可加载**：`load_template` 对 `tact.temperature.json` v0.1.0 与 `zizes.temperature.json` v0.2.0 均加载成功，row_anchors/layout 完整。PASS
2. **真值全部数值字段进入验证分母**：6 份真值各 7 个数值字段键、23 个非空元素，合计 **138 元素全部计入分母**（校准提取比对 `output/tact_calib/accuracy_report_tact_calib.json` 的 n_elements 总计 = 138）。PASS
3. **漏算最小自动检查**：构造含未知数值字段（`mystery_field`）的真值，`verify_accuracy.py` 非零退出并报「真值数值字段未被 NUMERIC_FIELDS 覆盖」。该检查已固化在脚本内，长期有效。PASS
4. **关键词全库碰撞检查**：对全库 117 份 OCR（覆盖佳明/伯乐 KEBA+B_AND_R/发那科/阿博格/沙迪克/德马格/日精 v2 全集 + 遗留 v1 文件）跑 `score_all_families`，TACT 关键词仅命中日精/tact 文件及两份屏幕内容确为 TACT 的遗留文件（见「风险」2/3）；佳明、伯乐 v2、发那科、阿博格、沙迪克、德马格 **零命中**，TACT 模板不会被其他家族加载。6 张 TACT 图路由均为 TACT（0.95-1.0）/ temperature。PASS
5. **ZizES 不退化**：`output/rectified` 21 份 ZizES 系列提取重跑与 `output/extracted` 既有结果 **零 diff**（status/family/page/heater_columns/fields/warnings 全等）；`verify_accuracy.py` 对 `ground_truth/zizes_temperature` 重跑六项指标与已提交基线 `output/accuracy_report.json` **完全一致**（数值准确率 1.0、错误自动入库率 0.0，双 gate PASS）。PASS

补充（校准态提取试跑，非 S2 验收）：6 图提取 ok=2 / review=4 / reject=0；数值准确率 131/138 = 94.93%、字段完整率 132/138、错误自动入库率 0.0。失分 7 元素全部为 OCR 检测层漏检/误读（坐标归属无误），详见风险 1。

## 风险与备注

1. **OCR 小数字漏检影响 S2 门槛**：PaddleOCR 默认 `det_limit_side_len=960` 对 2000px 矫正图降采样检测，rank01（竖拍 1975×2000）落下口设定/当前与 2 个保温值漏检或误读（'33.3'→'866'），rank02/rank05 各漏 1-2 个保温值。诊断显示 `det_limit_side_len=2000` 可恢复其中 5/7 元素（rank05 绿框图 2 个保温值仍漏）。修改 OCR 参数超出 S1「最小改动 extract_fields/verify_accuracy」范围且会变动 ZizES 既有 OCR 基础，**留待 S2 或用户决策**；按当前链路默认参数，S2 数值准确率预计约 94.9%，低于 95% 门槛，S2 报告应如实判 FAIL 并携带本诊断。
2. **boletuo_Z001 文件名与屏幕内容不符**：遗留 v1 文件 boletuo_Z001_t1-t3 的 OCR 含「TACT」标识与「成形条件名称：TX21012」（与 Z022 rank01 同成形条件号），屏幕实为 TACT，按内容路由 TACT 属正确；record 级聚合报告亦判 TACT。文件名「伯乐」系早期命名遗留，不构成本模板污染。
3. **rijing_Z022 record 级报告为 FANUC 的既有不一致**：`output/record_classify_report.json` 中 rijing_Z022 聚合为 FANUC，但其单图 OCR 强命中 TACT 关键词（日精拼音文件名）。系 015 之前既有数据，本切片未触碰；本切片 6 张图的 stem 不命中 record 报告 key，走单图分类兜底路由正确。
4. **rank04 CURRENT_SET_INCONSISTENT（后部 254.6 vs 260.0）**：与真值一致，属真实加热偏差，按保守设计判 review（同 ZizES rec201 先例），非提取错误。
5. 校准集=验收集（同 6 张 Z022/A06），模板只声明链路可运行，不声明跨机台/跨屏变体泛化；B09/B10 及其他机台另行立项。
6. 真值采用整批概览确认（`visual_skim_acceptance` 降级口径），结论不得表述为独立盲标。
7. `allow_auto_import=true` 仅真值夹具元数据，本计划不授权生产真实自动入库。

## 下一步（S2）

按 015 PLAN 的 S2：从 6 份真值的 `image` 精确选图建立隔离运行输入（不混入 `docs/samples_tact/` 4 张候补）→ 只跑一次完整链路（去重→质量门禁→矫正→OCR→分类→提取→比对）→ 六项指标报告逐项报告分母/缺失/不匹配 → S2 HANDOVER 按门槛（数值准确率 ≥95%、错误自动入库率严格 =0，空分母 FAIL）明确判定 PASS/FAIL。风险 1 的 OCR 检测分辨率决策是 S2 门槛判定的关键输入。
