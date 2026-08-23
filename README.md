# HMI Data Reader

提取注塑机控制屏（HMI）拍照图片里的设定工艺参数，转为结构化数据。

## 数据源

- 飞书多维表格 **生产工艺日报表**（base_token: `Vz2QbZ0lkagmVJsrMZ7cQwbSnZc`，table_id: `tbl5KKYuANqGpycE`）
- 高价值字段（attachment 类型）：
  - `成型条件-炮筒温度设定`
  - `成型条件-射出/保压`
  - `成型条件-储料/冷却`
  - `成型条件-成型监控一/二`
  - `成型条件-波形图`

## 目标

把每天每台机台约 3-5 张控制屏拍照图片里的设定参数抽取出来，入库回填到飞书 Base，替代每月 ~6000+ 张图的 vision 手动读取，节省 token 成本。

## 当前状态（2026-07-30）

**S2 record 级控制器识别 + S4 ZizES 温度页端到端薄切片已跑通（PoC）：**

| 模块 | 状态 |
|---|---|
| OCR 环境（PaddleOCR 2.7 + PP-OCRv4 ch）| ✅ 已装 |
| SHA-256 去重 | ✅ `scripts/dedup.py` |
| 质量门禁（屏幕检测 + 透视/反光/模糊评分 + 三色 triage）| ✅ `scripts/quality.py`（透视指标已改为四角对边比真实测量）|
| 单图 OCR → (text, bbox, conf) JSON | ✅ `scripts/ocr_one.py` |
| OCR 后处理（品牌模糊匹配 + 同行合并 + 数字约束）| ✅ `scripts/postprocess.py` v0.1.0 |
| UI 家族识别 + 页面识别（基于 OCR 文本关键词）| ✅ `scripts/classify_ui.py`（含 `score_all_families` 全向量打分）|
| S2 record 级控制器识别（离线聚合 + dedup 代表选取）| ✅ `scripts/aggregate_record.py` → `output/record_classify_report.json` |
| 屏幕四角检测 + 透视矫正 | ✅ `scripts/rectify.py`（检测失败降级 MANUAL_SCREEN_CONFIRM）|
| S4 字段提取（OCR + 归一化模板，VLM 不进提取链路）| ✅ `scripts/extract_fields.py` |
| S4 真值比对（6 项指标）| ✅ `scripts/verify_accuracy.py` → `output/accuracy_report.json` |
| ZizES 温度页模板（归一化坐标，5 样本校准）| ✅ `templates/zizes.temperature.json` v0.2.0 |
| S1 机器先验（VLM 草稿 + 人工核验）| ✅ `ground_truth/machine_labels.json` |
| S3 ZizES 温度页真值集（5 张，逐字段核验）| ✅ `ground_truth/zizes_temperature/` |
| 主入口流水线（去重 → 质量 → 矫正 → OCR → 分类 → 提取 → 比对）| ✅ `scripts/run_pipeline.py` |
| 其余家族模板（KEBA/弘讯/EST/B&R/KAIMING）| ⏳ 待 ZizES 达标后复制 |
| 入库（lark-cli base +record-upsert）| ⏳ 扩样验证通过前禁止真实自动入库 |

**S4 PoC 验收（5 张真值，2026-07-30）**：数值准确率 100%（门槛 ≥95%）、错误自动入库率 0（门槛严格 =0）、字段完整率 100%、控制器/页面分类准确率 100%、可自动入库比例 80%（rec201 报警态保守判 review）。达标仅表示允许进入扩样验证，不代表许可生产自动入库。

## 项目结构

```
hmi_data_reader/
├── README.md
├── docs/
│   ├── 000_INDEX.md
│   ├── 006_REPORT_20260729_架构重新梳理.md
│   ├── 007_PLAN_20260730_端到端薄切片实施计划.md
│   └── samples*/                          # 样本图片（samples / samples_v2 / samples_v3）
├── ground_truth/
│   ├── machine_labels.json                # S1 机器先验（唯一先验事实源）
│   └── zizes_temperature/                 # S3 ZizES 温度页字段级真值（5 张）
├── scripts/
│   ├── dedup.py                           # SHA-256 去重
│   ├── quality.py                         # 质量门禁（屏幕/透视/反光/模糊）
│   ├── rectify.py                         # 屏幕四角检测 + 透视矫正
│   ├── ocr_one.py                         # 单图 PaddleOCR → 结构化 JSON
│   ├── postprocess.py                     # OCR 后处理（品牌模糊/同行合并/数字约束）
│   ├── classify_ui.py                     # UI 家族 + 页面识别（含全向量打分）
│   ├── aggregate_record.py                # S2 record 级控制器识别（离线聚合）
│   ├── extract_fields.py                  # S4 字段提取（OCR + 归一化模板）
│   ├── verify_accuracy.py                 # S4 真值比对（6 项指标）
│   └── run_pipeline.py                    # 主入口（去重→质量→矫正→OCR→分类→提取→比对）
├── templates/
│   └── zizes.temperature.json             # ZizES 温度页模板 v0.2.0（归一化坐标）
├── models/                                # 模型缓存（占位）
├── output/
│   ├── json/                              # 原图 OCR JSON（含 postprocessed 变体）
│   ├── rectified/                         # 矫正图 + 其 OCR 产物（批量产物，不进 git）
│   ├── extracted/                         # 字段提取结果（批量产物，不进 git）
│   ├── record_classify_report.json        # S2 聚合报告
│   └── accuracy_report.json               # S4 6 项指标报告
└── .venv/                                 # uv venv（PaddleOCR 2.7 + paddle 2.6）
```

## 安装与运行

```bash
# 进入项目目录
cd /data1/code/hmi_data_reader

# 激活 venv
source .venv/bin/activate

# 安装依赖（已装好）
# uv pip install paddleocr==2.7.3 paddlepaddle==2.6.2 numpy opencv-python-headless

# 运行完整流水线（去重 → 质量 → 矫正 → OCR → 分类 → 提取 → 真值比对）
python scripts/run_pipeline.py docs/samples_v3 --output output/pipeline_report.json \
    --extract --verify ground_truth/zizes_temperature --verify-output output/accuracy_report.json

# S2 record 级控制器识别（离线聚合，唯一规范输入 *.ocr.postprocessed.json）
python scripts/aggregate_record.py output/json --labels ground_truth/machine_labels.json \
    --output output/record_classify_report.json

# 单独跑去重
python scripts/dedup.py docs/samples/ --output output/dedup.json

# 单独跑质量门禁
python scripts/quality.py docs/samples/*.jpeg --output output/quality.json

# 单独跑单图 OCR
python scripts/ocr_one.py docs/samples/jiaming_Z052_t1_炮筒.jpeg --output output/json/jiaming_Z052_t1.ocr.json

# 单独跑透视矫正（输出矫正图 + 屏幕尺寸 meta）
python scripts/rectify.py docs/samples/jiaming_Z052_t1_炮筒.jpeg output/rectified/jiaming_Z052_t1_炮筒.png \
    --meta output/rectified/jiaming_Z052_t1_炮筒.rectify.json

# 单独跑字段提取 / 真值比对
python scripts/extract_fields.py --all --rectified-dir output/rectified --output-dir output/extracted
python scripts/verify_accuracy.py output/extracted --truth ground_truth/zizes_temperature \
    --output output/accuracy_report.json
```

### 单图解释与验收（不重跑 OCR）

当前生产字段提取链仍是 `OCR -> 家族/页面路由 -> 模板/专用提取器 -> warning -> ok/review/reject`；
VLM 混合链只用于离线实验，尚未替代生产模板。可直接用已有 OCR sidecar 查看某张图实际走了
哪条路、用了哪个模板、为何禁止自动导入，以及逐字段真值差异：

```bash
.venv/bin/python scripts/explain_case.py barrel_A11_9835fbea \
  --rectified-dir output/s083_direct_fixes/rectified \
  --truth datasets/calibration/fanuc.temperature.rightmost5/barrel_A11_9835fbea.truth.yml \
  --no-priors

.venv/bin/python scripts/explain_case.py hr_B03_54b7a68e \
  --rectified-dir output/s075_rf/rectified \
  --truth datasets/holdout/tact.hot_runner_temp.digital_sv/hr_B03_54b7a68e.truth.yml \
  --no-priors
```

`--no-priors` 会关闭机台标签与 record 报告，只验证图片 OCR 内容本身的路由；去掉它就是正常离线提取口径。
该命令从已有 OCR JSON 开始，不覆盖原图质量门禁、透视矫正和 OCR 模型本身。

## 关键设计决策

### 路由基于图片像素，不基于品牌/字段名

- 飞书字段名「成型条件-炮筒温度设定」里实际可能是「射出·计量」Tab 的照片（见 docs/001 §数据陷阱）
- 不能按飞书 brand/machine_label 选择解析模板
- 模板按 `UI家族.页面` 组织（例 `ZizES.temperature`），禁止按品牌组织

### 三色 triage

- **绿灯**：UI 家族 + 页面明确 + 质量合格 → 自动入库
- **黄灯**：可矫正或部分字段可读 → 保留 OCR 候选 + 置信度，人工复核
- **红灯**：重复 / 严重反光 / 模糊 / 斜拍 / 屏幕过小 / 页面未知 → 拒识 + 重拍指引

### OCR 模型选择

- **PaddleOCR 2.7.3 + PP-OCRv4 ch**（det + rec + cls 三个模型已下载到 `~/.paddleocr/whl/`）
- CPU 模式跑（避免与 vLLM 抢 GPU 显存；gemma-4-31B-it 已停）
- PaddleOCR 3.x 在本环境的 paddle 3.3 / 3.4 + onednn 上有已知 PIR 兼容 bug，2.7 是当前唯一稳定路径

### 持久化重跑

- 中间产物落在 `output/json/`（每张图一个 OCR JSON）
- `output/dedup_report.json` `output/quality_report.json` `output/classify_report.json` 各自独立

## 凭证 / 环境

| 名称 | 位置 | 备注 |
|---|---|---|
| 飞书 base token | `Vz2QbZ0lkagmVJsrMZ7cQwbSnZc` | |
| 飞书 table id | `tbl5KKYuANqGpycE` | |
| OCR 模型缓存 | `~/.paddleocr/whl/{det,rec,cls}/` | |
| GPU | 2 × NVIDIA A100 80GB PCIe | GPU 0 空（gemma-4-31B-it 停），GPU 1 跑 Qwen3.6 |

## 下一步

1. T2 验收：S2 record 级分类与 S1 标签的冲突率/准确率验收（`output/record_classify_report.json` vs `ground_truth/machine_labels.json`）
2. S2 召回改进：unknown 图片比例 31.7%（远超 ≤5% 门槛），需品牌模糊匹配进分类链路或标题区加权
3. 扩样验证：ZizES 温度页扩到更多机台/日期，确认 5 张 PoC 结论在更大样本上成立后才允许谈自动入库
4. 复制模板到其余家族（KEBA/B_AND_R/KAIMING 等，按 006 报告 §3 节奏）
5. KAIMING 族（佳明 Z030/Z062）模板与真值集新建
