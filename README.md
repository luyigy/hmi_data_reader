# HMI Data Reader

提取注塑机控制屏（HMI）拍照图片里的设定工艺参数，转为结构化数据。

## 文件放在哪里（2026-09-27 整理）

| 内容 | 位置 |
| --- | --- |
| 飞书原图、历史样本 | `datasets/hmi/raw/` |
| 标注包、人工复核队列 | `datasets/hmi/annotations/` |
| 样本清单、来源与验收索引 | `datasets/hmi/catalog/` |
| 已有真值、留出与回归基线 | `ground_truth/`、`datasets/holdout/`、`datasets/regression/` |
| 训练运行、adapter、输入快照 | `output/training/` |
| 框复核、对照图、验收证据 | `output/reviews/` |
| 推理测试 | `output/inference-tests/` |
| 训练日志、历史运维杂项 | `output/logs/training/`、`output/archive/training-prep/` |
| 代码与回归检查 | `scripts/`、`tests/` |
| 说明、报告与交接 | `docs/`，入口 [文档索引](docs/000_INDEX.md) |

新增数据从 [HMI 数据目录说明](datasets/hmi/README.md) 进入。历史 `docs/*sample*` 和
`output/training-prep/*` 已保留为兼容链接；新产物按上表存放，不再往旧目录平铺。
图片、标注、权重被 Git 忽略，必须单独备份；Git 仓库不是训练数据备份。

## 当前页面支持与代码入口（2026-11-02）

当前仅支持 **B&R 射胶保压组合页** `b_and_r.injection_holding.multi_stage_position_time`。
其他品牌及其他页型的提取实现和活动模板已移除，历史照片、真值、训练数据与文档保留。
未知或未接入页面保留 OCR 证据，拒绝输出工艺字段；不再使用通用字段提取兜底。

页面代码集中于：

```text
scripts/extract_families/b_and_r/injection_holding/
├── page_identity.py       # 页面身份与结构标题证据
├── layout.py              # 射胶/保压布局，含中文算法讲解
├── extractor.py           # v1/v2 字段读值
├── observations.py        # 原屏观测输出
├── package.py             # 固定版本包和源码哈希
└── verify_stability.py    # 页面冻结回放
```

目录按控制器和具体页面组织：`<controller>/<page>/`。完整 profile 是注册身份，不机械映射目录层级。新增页面在自己的目录实现，
再接入公共 `page_identity.py` 与 `extractor_registry.py`，不得向 HTTP/CLI 添加页面分支。
`common.py`、`visual_cells.py`、`coordinates.py` 是公共原语。
测试位于 `tests/pages/b_and_r.injection_holding.multi_stage_position_time/`，共用入口边界测试位于
`tests/test_reader_page_boundary.py`。

- `contracts/profiles.json`：活动页面登记表，只登记当前一个页面及模板路径。
- `templates/b_and_r/injection_holding.json`：活动 v1 模板。
- `templates/raw-packages/<profile>/<version>.json`：不可原地修改的 v2 交付包。
  原 `0.6.0`、`0.6.1` 保留用于历史导出；当前源码身份使用新 `0.6.2`。
- `contracts/field_catalog.json` 和公共 schema：保持现有契约，字段存在不等于页面已支持。

离线验证：

```bash
PYTHONPATH=scripts:. PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest tests -q
.venv/bin/python scripts/extract_families/b_and_r/injection_holding/verify_stability.py --output /tmp/br-stability
```

这些检查区分冻结 OCR 和真实在线 OCR，不代表 mold 已接纳新包。
清理基线标签：`backup/reader-before-page-cleanup-20261102`，指向
`1308f26e9189f35dfdd77c2cb81364b6d391437c`。回滚说明见
[Reader 单页面清理交接](docs/151_HANDOVER_20261102_Reader单页面清理完成.md)。

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

## 历史研发状态（2026-07-30）

以下为历史记录，包含已撤下的页面；当前运行支持范围以本页上方的单页面说明为准。

**S2 record 级控制器识别 + S4 ZizES 温度页端到端薄切片已跑通（PoC）：**

| 模块 | 状态 |
|---|---|
| OCR 环境（PaddleOCR 2.7 + PP-OCRv4 ch）| ✅ 已装 |
| SHA-256 去重 | ✅ `scripts/dedup.py` |
| 质量门禁（屏幕检测 + 透视/反光/模糊评分 + 三色 triage）| ✅ `scripts/quality.py`（透视指标已改为四角对边比真实测量）|
| 单图 OCR → (text, bbox, conf) JSON | ✅ `scripts/ocr_one.py` |
| OCR 后处理（品牌模糊匹配 + 同行合并 + 数字约束）| ✅ `scripts/postprocess.py` v0.1.0 |
| UI 家族识别 + 页面识别（基于 OCR 文本关键词）| ✅ `scripts/classify_ui.py`（含 `score_all_families` 全向量打分）|
| S2 record 级控制器识别（离线聚合 + dedup 代表选取）| ✅ `scripts/data_tools/aggregate_record.py` → `output/record_classify_report.json` |
| 屏幕四角检测 + 透视矫正 | ✅ `scripts/rectify.py`（检测失败降级 MANUAL_SCREEN_CONFIRM）|
| S4 字段提取（OCR + 归一化模板，VLM 不进提取链路）| ✅ `scripts/extract_fields.py` |
| S4 真值比对（6 项指标）| ✅ `scripts/evaluation/verify_accuracy.py` → `output/accuracy_report.json` |
| ZizES 温度页模板（归一化坐标，5 样本校准）| ✅ `templates/zizes.temperature.json` v0.2.0 |
| S1 机器先验（VLM 草稿 + 人工核验）| ✅ `ground_truth/machine_labels.json` |
| S3 ZizES 温度页真值集（5 张，逐字段核验）| ✅ `ground_truth/zizes_temperature/` |
| 主入口流水线（去重 → 质量 → 矫正 → OCR → 分类 → 提取 → 比对）| ✅ `scripts/operations/run_pipeline.py` |
| 其余家族模板（KEBA/弘讯/EST/B&R/KAIMING）| ⏳ 待 ZizES 达标后复制 |
| 入库（lark-cli base +record-upsert）| ⏳ 扩样验证通过前禁止真实自动入库 |

**S4 PoC 验收（5 张真值，2026-07-30）**：数值准确率 100%（门槛 ≥95%）、错误自动入库率 0（门槛严格 =0）、字段完整率 100%、控制器/页面分类准确率 100%、可自动入库比例 80%（rec201 报警态保守判 review）。达标仅表示允许进入扩样验证，不代表许可生产自动入库。

## 项目结构

工具的逐文件说明从 [scripts/README.md](scripts/README.md) 进入。

```text
hmi_data_reader/
├── hmi_service.py                 # 公共 HTTP 服务
├── scripts/
│   ├── README.md                  # 运行模块与工具导航
│   ├── extract_fields.py          # 公共提取编排
│   ├── page_identity.py           # 页面身份路由
│   ├── ...                        # 公共 OCR、质量、契约模块
│   ├── extract_families/          # 控制器/页面/布局独立实现及专属回放
│   ├── data_tools/                # 图片、标注、数据集治理
│   ├── training/                  # 模型下载、训练和试验推理服务
│   ├── evaluation/                # 真值评测、批量识别
│   ├── diagnostics/               # 标注预览、单图解释
│   ├── integrations/              # 飞书等外部入口
│   └── operations/                # 离线流水线、模板与生命周期操作
├── templates/                     # B&R 活动模板和固定版本包
├── contracts/                     # 活动页面注册、字段目录与 schema
├── datasets/                      # 原图、标注、训练/评测清单，不随工具代码移动
├── ground_truth/                  # 保留的历史真值
├── tests/                         # 公共测试及独立页面测试
├── docs/                          # 历史设计、计划和交接
└── output/                        # 运行和验收产物
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
python scripts/operations/run_pipeline.py docs/samples_v3 --output output/pipeline_report.json \
    --extract --verify ground_truth/zizes_temperature --verify-output output/accuracy_report.json

# S2 record 级控制器识别（离线聚合，唯一规范输入 *.ocr.postprocessed.json）
python scripts/data_tools/aggregate_record.py output/json --labels ground_truth/machine_labels.json \
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
python scripts/evaluation/verify_accuracy.py output/extracted --truth ground_truth/zizes_temperature \
    --output output/accuracy_report.json
```

### 单图解释与验收（不重跑 OCR）

当前生产字段提取链仍是 `OCR -> 家族/页面路由 -> 模板/专用提取器 -> warning -> ok/review/reject`；
VLM 混合链只用于离线实验，尚未替代生产模板。可直接用已有 OCR sidecar 查看某张图实际走了
哪条路、用了哪个模板、为何禁止自动导入，以及逐字段真值差异：

```bash
.venv/bin/python scripts/diagnostics/explain_case.py barrel_A11_9835fbea \
  --rectified-dir output/s083_direct_fixes/rectified \
  --truth datasets/calibration/fanuc.temperature.rightmost5/barrel_A11_9835fbea.truth.yml \
  --no-priors

.venv/bin/python scripts/diagnostics/explain_case.py hr_B03_54b7a68e \
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
