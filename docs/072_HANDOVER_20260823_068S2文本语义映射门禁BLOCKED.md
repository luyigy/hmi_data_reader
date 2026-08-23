---
doc_type: HANDOVER
doc_status: blocked
next_action: blocked
plan: docs/068_PLAN_20260823_OCR主读与VLM语义辅助.md
slice: S2
plan_progress: in_progress
date: 2026-08-23
---

# 068 S2 文本语义映射门禁阻塞交接

## 结论

S2 的最小离线文本调用、OCR token 引用校验和固定清单 runner 已完成；生产入口、服务状态和 8000 均未触碰。实际 8003 小批出现系统性字段误映射和数组错位，触发 068 PLAN 的立即停止条件，因此未运行 89 例固定清单，也不得进入 S3。

## 实现边界

- 请求只包含当前页 S1 OCR `tokens/rows/page_type` 和当前页 catalog 字段的 `label_zh/value_type/unit/order` 子集，不含原图或跨页字段。
- 模型只允许返回 `field/value_token_ids/screen_order/active_count` 引用；业务数值由本地从 OCR token 文本构造。
- 未知字段/token、重复 token/字段占用、越界段数、坏 JSON、直接数值、非法标量/数组结构和 OCR `O/I/l` 数字歧义均受控拒绝。
- 文本评测强制显式环境值 `HMI_VLM_BASE_URL=http://localhost:8003/v1`、`HMI_VLM_MODEL=Qwen3.8-27B-AWQ-INT4`；`/v1/models` 检查通过。
- Qwen thinking 会耗尽 2000 completion tokens 并返回 `content=null`；文本请求已仅对该受约束任务设置 `enable_thinking=false`，未提高 token 上限。

## 评测结果

离线安全检查：3 passed；连同 generic/contract 聚焦回归为 27 passed、22 subtests passed。覆盖标量、数组、反序、禁用段、未知字段/token、重复占用、越界段数、坏 JSON、直接数值与 OCR 歧义。

实际 8003 小批固定取 5 例，输出位于忽略目录 `output/068_s2_text_small/`：

- field mapping accuracy：0.7000
- structure accuracy：0.4545
- numeric accuracy：0.6857（门禁 ≥ 0.95，FAIL）
- error auto-import rate：0.3143（门禁 = 0，FAIL）
- rejection accuracy：0.5000（门禁 = 1，FAIL）
- illegal reference rate：0.2000；parse failure rate：0；非 OCR 来源数值：0
- latency p50/p95/max：1.887 / 8.963 / 8.963 秒
- token usage：prompt 14924、completion 1417、total 16341

典型失败为温度页把无关 token 映为保温温度、控制百分比数组长度不足，以及保压页把多值 token 映给标量。失败已由本地严格校验或 `verify_accuracy.py` 口径暴露，没有进入生产或污染字段。

## 验证与既有问题

- 全量回归：195 passed、27 subtests passed；仅 2 条既有 FastAPI `on_event` 弃用 warning。
- dataset meta/release manifest 仍为 contract `2.8.0`，catalog 为 `2.11.0`；本次未修改任何数据治理资产，评测禁止 lifecycle 晋级。
- GitNexus 全局 CLI 安装时曾因 onnx 下载失败，随后以 `--ignore-scripts` 安装并补齐 LadybugDB；现有索引可查询但刷新因缺 `tree-sitter-swift` 失败。新增符号 impact 均为未索引、0 impacted、UNKNOWN，未出现 HIGH/CRITICAL。

## 修改文件

- `scripts/vlm_qwen.py`
- `scripts/vlm_text_eval.py`
- `tests/test_vlm_text_mapping.py`
- `docs/072_HANDOVER_20260823_068S2文本语义映射门禁BLOCKED.md`
