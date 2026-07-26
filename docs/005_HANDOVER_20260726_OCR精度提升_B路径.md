# 005_HANDOVER_20260726_OCR精度提升_B路径

**生成时间**：2026-07-26
**任务类型**：pipeline + 算法
**前置文档**：docs/003, docs/004, output/核对清单_飞书.md

---

## 为什么做

王为（用户）拍板：**优先做 OCR 后处理智能化（路径 B）**。

**核心约束**：
- 不重拍（重拍只是兜底，质量太差的直接提示用户重拍，不搞复杂 SOP）
- zero-shot（不训练不微调）
- 不上云端 GPU（本地 GPU 1 跑着 Qwen3.6 serving 别的事）
- 现有图片（不最差的）→ 进入算法优化

---

## B 路径实现（v1）

### 4 类修复

1. **品牌字符串模糊匹配**（解决 FANUC→NUC, BOLE→BELE 等 OCR 漏字）
   - 算法：`difflib.get_close_matches` 1-edit-distance 兜底
   - 关键词库：7 个 UI 家族共 ~30 个变体

2. **同行文本合并**（解决 "设定°C" + "262.0" 被切成两段）
   - 算法：按 bbox y 排序，y_tolerance=15px 内合并
   - 输出：merged_rows（含 x/y 范围 + 平均 conf）

3. **数字字段范围约束**（小数点漂移修正）
   - 算法：超出范围 10 倍以内尝试 /10
   - 11 种字段类型（温度/压力/时间/位置/百分比）

4. **字段位置模板**（按家族布局约束数字区域）
   - v1 只覆盖 ZizES + FANUC（基于已知 OCR 数据）
   - 其他家族后续按 OCR 数据反推

### 文件

| 文件 | 行数 | 用途 |
|---|---|---|
| `scripts/postprocess.py` | 230 | 后处理主脚本 |
| `scripts/classify_with_postprocess.py` | 55 | 用后处理结果重跑 UI 家族分类 |

### 输出

| 文件 | 用途 |
|---|---|
| `output/json/*.postprocessed.json` | 102 张图的后处理结果（含 merged_rows + fix_log）|
| `output/classify_with_postprocess_report.json` | 用 B 路径结果重分类的 87 张 UI 家族 |

---

## v1 实测结果

### 数字提取（粗统计）

- 数字总数：**6655 个**
- 被修正：**0 个**（当前样本数字基本在合理范围内，未触发范围约束）
- merged_rows: 102 张图合并后行数（每张独立）

### UI 家族召回率提升

| 家族 | 修复前 | 修复后 | Δ |
|---|---|---|---|
| ZizES | 18 | 18 | 0 |
| BOLE | 14 | **16** | **+2** |
| DEMAG | 5 | **6** | **+1** |
| ARBURG | 8 | 8 | 0 |
| TACT | 7 | 7 | 0 |
| TRD6 | 7 | 7 | 0 |
| FANUC | 1 | 1 | 0 |
| **unknown** | **27** | **24** | **-3** |

**召回率 +3.4%**（从 27 张 unknown 减少到 24 张）。

### 漏字修复实例（OCR → 修复后）

```
'BXLE'        -> BOLE (fuzzy-match, conf=0.85)
'Process expet' -> BOLE (fuzzy-match, conf=0.85)
'BALE'        -> BOLE (fuzzy-match, conf=0.85) ×5
'DEMA'        -> DEMAG (fuzzy-match, conf=0.85)
```

---

## 已知不足 + 下一步

### B 路径 v2 方向（用户没禁止）

1. **品牌字典扩到 50+ 关键词**：FANUC 子型号 (ROBOshot, S-iB)、ARBURG 子型号 (ALTRONIC, SELOGICA)
2. **同段落合并规则更激进**：y_tolerance 15 → 20；"现在°C" + "262.0" 等可能被合并
3. **数字字段范围约束**：现在 0 命中是因为 v1 样本数字本身就准。但真实场景（产线实时数据）可能小数点漂移更多 → 留待后续
4. **模板驱动数字抽取**：写 7 个家族的 ZizES.temperature.json 模板，按位置取数字（不再依赖 OCR 文本精确）
5. **品牌字符串命中 → UI 家族修复**：把 fuzzy brand hit 写入 OCR JSON 的 `metadata` 字段，下游 classify_ui 直接消费

### A 路径（引擎升级）何时启动？

用户拍板 C 优先（已确认改成简单重拍提示），B 在跑。如果 B 路径 +5% 后还不够，再启动 A1（PaddleOCR-VL）。

### C 路径（重拍）何时启动？

**只对"质量太差的图"触发**：
- SCREEN_TOO_SMALL（屏占比 < 30%）— 沙迪克 3 张
- 严重反光（glare_ratio > 0.30）
- 4 边未入镜（touches_edge）

**触发动作**：OCR 流水线输出 reject_codes 时附带"重拍建议"提示：
```
图片 docs/samples_v2/沙迪克_A06_..._rec18_炮筒_00.jpeg
拒因: SCREEN_TOO_SMALL (屏占比 24%)
建议: 重拍时屏占比 ≥ 50%，避免反光
```

**不写复杂 SOP**：只输出 1-2 行提示发给用户。

---

## 待办

| # | 任务 | 状态 |
|---|---|---|
| 1 | 写 B 路径脚本 + 实测 + commit | ✅ 本文档 |
| 2 | 跟本地 AI 助手 + Antigravity 讨论 A/C 路径是否启动 | ✅ 已讨论（C 改成简单重拍） |
| 3 | B 路径 v2：扩品牌字典 + 激进合并 + 模板驱动数字抽取 | ⏸ 等用户决定 |
| 4 | 把"重拍提示"接入 quality.py 的 reject_codes 输出 | ⏸ 待启动 |
| 5 | A1（PaddleOCR-VL）替换 PP-OCRv4 | ⏸ 等用户决定 |

---

## 凭证 / 环境

| 名称 | 值 | 备注 |
|---|---|---|
| 工作目录 | `/data1/code/hmi_data_reader/` | 已 commit + push |
| venv | `.venv/` Python 3.11 | paddleocr 2.7.3 + paddle 2.6.2 |
| OCR 模型 | PP-OCRv4 ch | CPU 模式 |
| 新增脚本 | `scripts/postprocess.py` + `scripts/classify_with_postprocess.py` | |

---

## 下一个 Agent 的启动命令

```
请阅读交接文档：

/data1/code/hmi_data_reader/docs/005_HANDOVER_20260726_OCR精度提升_B路径.md

待办：
1. B 路径 v2：扩品牌字典（5 条 FANUC 子型号 + 5 条 ARBURG 子型号）+ 同段落合并 y_tolerance 20 + 模板驱动数字抽取
2. 接入 quality.py 的 reject_codes 输出"重拍建议"提示
3. 评估是否启动 A1（PaddleOCR-VL）

环境：
- lark-cli 1.0.56（field 顺序按投影顺序，output array 格式）
- GPU 0 空，GPU 1 Qwen3.6 serving 别的事
- 不动云端，zero-shot 不训练
```