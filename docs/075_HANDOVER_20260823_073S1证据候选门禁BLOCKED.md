---
doc_type: HANDOVER
doc_status: blocked
next_action: blocked
plan: docs/073_PLAN_20260823_OCR证据混合链落地.md
slice: S1
plan_progress: in_progress
date: 2026-08-23
---

# 073 S1 证据候选门禁阻塞交接

## 结论

S1 已复用 CLAHE、zoom、rate、temperature-cell、cell、stage、moire、delay、setrow、hot-runner、mold-temp 旁车，并用 catalog 标签、单位及标量/数组结构为“标签已识别但值或结构不确定”的字段补充 unresolved。离线链同时恢复现有模板/专用提取器的增量贡献统计；generic、模板和 VLM 均不得覆盖更早已解决字段，VLM 参与或仍有 unresolved 的结果保持 review。未增加机台/单图 prompt 规则，未修改 `scripts/extract_fields.py`、`hmi_service.py`，未重启服务，未访问 8000。

固定 89 例三项硬门禁全部失败，因此本计划停在 S1，不得派发 S2。

## 实现与验证

- catalog 候选仅在字段属于当前页、标签有 OCR 证据、单位相容且数值数量符合标量/数组结构时进入 unresolved；`%` 与 `mm/s` 明确隔离。
- 小样本 4 例调用 8003 后，VLM 参与或仍 unresolved 的结果全部为 review，空字段为 reject，auto-import ratio=0；numeric accuracy=0.90。
- 固定 89 例含 31 个负样本：模板新增 193 字段（138 正确、55 错误）；VLM 新增 6 字段（1 正确、5 错误）；generic 新增 0 字段。
- VLM 调用 9/89，调用率 0.1011；prompt/completion/total tokens 为 40112/1791/41903。
- 延迟 p50/p95/max：generic 0.002/0.014/0.028 秒，模板 0.002/0.036/0.059 秒，VLM 2.698/6.333/6.333 秒。
- 数组长度准确率 0.7872，段序准确率 0.7447；非法引用率、解析失败率、非 OCR 来源数值均为 0。
- 门禁：numeric accuracy=0.8295（要求 >=0.95，FAIL）；error auto-import rate=0.0321（要求 0，FAIL）；rejection accuracy=0.8387（要求 1，FAIL）。
- 聚焦回归：35 passed、5 subtests passed；全量：203 passed、27 subtests passed；仅 2 条既有 FastAPI `on_event` 弃用 warning。
- 评测明细位于忽略目录 `output/073_s1_small/`、`output/073_s1_full/`。

## 阻塞原因与恢复条件

- 现有模板仍在 5 个负样本输出 ok，且模板字段错误 55 个；VLM 仅补对 1/6 字段，无法弥补模板误放行及模温 current 缺失。
- dataset contract 2.8.0 与 catalog 2.11.0 继续漂移，禁止 lifecycle 晋级。
- 只有在 S1 内修复通用模板/拒识根因并重新满足 numeric accuracy >=0.95、error auto-import rate=0、rejection accuracy=1、数组长度与段序门禁后，才可另写 ready HANDOVER 派发 S2。
- 工作区仍含本任务开始前的 10 个跟踪文件修改；GitNexus compare 对整体工作区报 CRITICAL（27 symbols、16 flows），主要含既有 `hmi_service.py` / contract 变更。本切片只增量修改 LOW/UNKNOWN 的离线 runner 与测试，不得整批暂存或提交。

## 修改文件

- `scripts/vlm_text_eval.py`
- `tests/test_vlm_text_mapping.py`
- `docs/075_HANDOVER_20260823_073S1证据候选门禁BLOCKED.md`
