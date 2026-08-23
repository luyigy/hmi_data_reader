---
doc_type: REPORT
doc_status: completed
next_action: none
date: 2026-08-23
plan: docs/068_PLAN_20260823_OCR主读与VLM语义辅助.md
slice: S0
---

# 068 S0 OCR 与 Generic 基线报告

## 1. 结论

S0 已完成只读基线建立，但触发停止条件，不能进入 S1：仓库的固定 dataset manifest 和全部 111 个 meta 仍绑定契约 `2.8.0`，当前 `contracts/field_catalog.json` 已是 `2.11.0`，`scripts/datasets.py check` 因 111 个 `contract_version` 漂移全部失败。

代码测试和 OCR sidecar 回放本身均可重复执行；由于 dataset 合同无效，本报告将回放数值定义为“现有失败基线”，不得作为 profile 晋级、S1 验收或生产放行证据。本切片未修改任何代码、测试、模板、真值、dataset、服务配置或既有工作区文件，未重启服务，未访问 8000/8003。

完整机器可读快照见 `artifacts/068_s0_baseline.json`，SHA-256 为 `84638c375335ed4e949991396fd2685f63ba234375698b0d3fe140eb01ddfe4d`。

## 2. 冻结基线

- HEAD：`6e807c61d53c35e1106a34107196b53f18989701`（`master`，相对 `origin/master` 领先 1）。
- Python：3.10.12；pytest 9.1.1；PaddleOCR 2.7.3；OpenCV 4.6.0.66；FastAPI 0.141.1；NumPy 1.26.4；PyYAML 6.0.3。
- 当前虚拟环境未安装 `paddlepaddle`；`nvidia-smi` 无法连接驱动。因此 S0 复用既有 OCR/矫正 sidecar，不重跑 GPU OCR。
- `pip freeze` 排序后 SHA-256：`11add3ff74305d74bc742dc642867d6102e1256a074232cd313fd393aad374f6`。
- 既有 tracked 定向 diff 合并 SHA-256：`b5456404aea03eaeb140aec2eb36078f3968840c08ac906037968bbd90cacfa2`；逐文件 diff hash 与 untracked 草稿文件 hash 已写入基线 JSON。

定向审阅确认：

- `extract_fields.py` 只在无模板路径调用现有 `extract_generic.py`；`contract.py` 将该结果限制为 `generic.spatial`、`candidate`、`review/reject`。
- `vlm_qwen.py` 与 `vlm_eval.py` 仍是离线“原图 + page_type”草稿，未接 `recognize_image`，也不是 PLAN 目标中的文本 token 引用接口。
- `hmi_service.py`、service unit、启动脚本及 EST 温度修订属于既有用户修改，本切片未采用、修复或提交它们。
- 未发现草稿文件互相覆盖或无法区分；低准确率属于能力基线，不是 S0 新增回归。

## 3. 固定样本清单

固定清单直接引用已提交的 `datasets/release_manifest.json`，文件 SHA-256：
`7fe44cf41a40f7250b978dbb2950c4ca347e56b46d9edf0e4f516494d4654d7b`。

| 分区 | 数量 |
|---|---:|
| calibration | 62 |
| holdout | 46 |
| regression | 3 |
| 合计 | 111 |

111 份真值均能找到对应图片，缺图数为 0；因此没有把缺图真值计入准确率分母。清单按 `partition/controller_family/page_type/positive-or-reject` 的完整分组计数、89 个回放 case ID、22 个无 sidecar 未回放 case 的排除规则均固化在基线 JSON。

89 例已有 `*.rectify.json` 与 OCR sidecar，可做纯 CPU 只读回放；其输入集合 SHA-256 为 `e832daa469bbb7e07be47664e6406b3be6484e420019fc873f6458dd0ae16925`。其余 22 例只有配对真值与图片，但本环境不能重跑 GPU OCR，故只进入样本清单，不进入模板/generic 回放分母。

## 4. 测试基线

### 4.1 聚焦测试

覆盖 generic、contract/profile、路由、温度、热流道、模温、KEBA/DEMAG 注射：

```text
.venv/bin/python -m pytest -q \
  tests/test_generic_extraction.py tests/test_contract.py tests/test_profile_lifecycle.py \
  tests/test_temperature_barrel_s02.py tests/test_temperature_hot_runner_s03.py \
  tests/test_temperature_profiles_s02.py tests/test_mold_temp_s04.py \
  tests/test_keba_injection.py tests/test_demag_injection.py
```

结果：116 passed，22 subtests passed，2 warnings，1.03 秒。

### 4.2 全量测试

```text
.venv/bin/python -m pytest -q tests
```

结果：190 passed，27 subtests passed，2 warnings，1.82 秒。两组 warning 均为 `hmi_service.py:112` 使用 FastAPI `on_event` 的既有弃用提示；无测试失败，无 S0 回归。

### 4.3 Dataset 合同检查

```text
.venv/bin/python scripts/datasets.py check
```

结果：FAIL。111/111 个 meta 报 `contract_version` 漂移：meta/release manifest 为 `2.8.0`，当前 field catalog 为 `2.11.0`。本切片按约束不重建 meta、不修改 manifest、不改真值，因此在此停止。

## 5. 只读回放

两条回放使用完全相同的 89 例 OCR sidecar，再交给仓库现有 `verify_accuracy.py` 以 contract 模式计分。

| 指标 | 当前模板链 | generic 草稿 |
|---|---:|---:|
| 图片数 | 89 | 89 |
| field completeness | 0.8346 | 0.1299 |
| numeric accuracy | 0.8270 | 0.0311 |
| error auto-import rate | 0.0291 | N/A（无 ok） |
| rejection accuracy | 0.8387 | 1.0000 |
| auto-import ratio | 0.4157 | 0.0000 |
| lifecycle eligible | false | false |

模板链状态为 `ok=37/review=12/reject=40`，其中 25 例因无模板实际进入当前 generic fallback；纯 generic 草稿为 `review=18/reject=71`。进程内单图耗时仅用于提取器相对基线，不包含 OCR：模板链 p50/p95/max 为 2.028/39.079/57.228 ms；generic 为 0.728/8.055/19.155 ms。

模板链三门禁全部失败；generic 仅 rejection 门禁通过。所有失败均在零代码改动的 S0 回放中出现，分类为既有失败。尤其 generic 在现有样本分布上不能作为主读链：它能独立执行、能安全保持 review/reject，但字段覆盖和数值正确率很低。

## 6. 阻塞与解除条件

S0 状态为 blocked，不派发 S1。解除阻塞至少需要：

1. 在独立、获批的数据集合同修复范围内，把 111 个 meta 与 release manifest 对齐当前 catalog `2.11.0`，且不污染 holdout；
2. `scripts/datasets.py check` 通过；
3. 用相同固定清单和回放输入重新生成 S0 基线，确认既有失败口径稳定；
4. 再由有效 HANDOVER 派发 068 S1。

本报告不授权直接运行 `datasets.py build`，因为它会批量改写受治理产物，超出本切片“只新增基线文档”的范围。
