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

## 当前状态（2026-07-25）

**Phase 0 续 — 最小闭环已建立：**

| 模块 | 状态 |
|---|---|
| OCR 环境（PaddleOCR 2.7 + PP-OCRv4 ch）| ✅ 已装 |
| SHA-256 去重 | ✅ `scripts/dedup.py` |
| 质量门禁（屏幕检测 + 透视/反光/模糊评分 + 三色 triage）| ✅ `scripts/quality.py` |
| 单图 OCR → (text, bbox, conf) JSON | ✅ `scripts/ocr_one.py` |
| UI 家族识别 + 页面识别（基于 OCR 文本关键词）| ✅ `scripts/classify_ui.py` |
| 主入口流水线（去重 → 质量 → OCR → 分类）| ✅ `scripts/run_pipeline.py` |
| 模板 | ⏳ 待 ZizES OCR 结果反推 |
| 入库（lark-cli base +record-upsert）| ⏳ |

## 项目结构

```
hmi_data_reader/
├── README.md
├── docs/
│   ├── 000_INDEX.md
│   ├── 001_HANDOVER_20260725_5品牌屏模板调研.md
│   ├── 002_RESEARCH_20260725_HMI图片真值与质量门禁.md
│   └── samples/                          # 15 张样本图片
├── scripts/
│   ├── dedup.py                          # SHA-256 去重
│   ├── quality.py                        # 质量门禁（屏幕/透视/反光/模糊）
│   ├── ocr_one.py                        # 单图 PaddleOCR → 结构化 JSON
│   ├── classify_ui.py                    # 基于 OCR 输出识别 UI 家族 + 页面
│   └── run_pipeline.py                   # 主入口（去重→质量→OCR→分类）
├── templates/                            # 待建：UI家族.页面 模板
├── models/                               # 模型缓存（占位）
├── output/
│   ├── json/                             # 每张图的 OCR JSON
│   ├── dedup_report.json
│   ├── quality_report.json
│   └── classify_report.json
└── .venv/                                # uv venv（PaddleOCR 2.7 + paddle 2.6）
```

## 安装与运行

```bash
# 进入项目目录
cd /data1/code/hmi_data_reader

# 激活 venv
source .venv/bin/activate

# 安装依赖（已装好）
# uv pip install paddleocr==2.7.3 paddlepaddle==2.6.2 numpy opencv-python-headless

# 运行完整流水线
python scripts/run_pipeline.py docs/samples/ --output output/full_report.json

# 单独跑去重
python scripts/dedup.py docs/samples/ --output output/dedup.json

# 单独跑质量门禁
python scripts/quality.py docs/samples/*.jpeg --output output/quality.json

# 单独跑单图 OCR
python scripts/ocr_one.py docs/samples/jiaming_Z052_t1_炮筒.jpeg --output output/json/jiaming_Z052_t1.ocr.json
```

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

1. ZizES 3 张绿灯样本跑出结构化 OCR → 反推 `templates/zizes.temperature.json`
2. TACT/FANUC 黄灯样本先做透视矫正 → 重测 → 评估 OCR 可行性
3. TRD6 红灯样本（沙迪克）→ 出明确重拍指引
4. 重新从飞书抽独立样本替换重复附件 → 重新评估真实 UI 家族数量