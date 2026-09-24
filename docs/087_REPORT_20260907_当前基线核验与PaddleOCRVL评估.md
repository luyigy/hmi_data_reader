---
doc_type: REPORT
doc_status: completed
next_action: none
---

# 当前基线核验与 PaddleOCR-VL 评估

核验日期：2026-09-07。范围：Reader 工作树、现有离线验证、本机服务只读接口、官方模型资料。本文不启动 workflow。

## 1. 基线定位

- HEAD：`4517951ec76683364e125d035ee0f7eec5b50caa`，分支 master；相对本地 origin/master 领先 25 个提交（本轮未 fetch，不代表远端实时状态）。
- 7 个已跟踪文件存在既有改动，合计 +73/-30；它们不等于 HEAD，也尚未作为新发布版本验收。
- 既有未跟踪 `docs/084_HANDOVER_20260825_Session换代_dbd32a78.md` 和 `docs/inbox/` 保留原样。084 是历史会话快照，不能拿其中旧派发提示当当前指令；inbox PLAN 尚无可执行 workflow 元数据。
- 本轮完成盘点、验证与留档，没有清空工作树或将既有代码打包提交，没有修改生产符号、升级依赖、安装模型、重启或部署。

| 既有改动 | 实际行为 | 收口注意事项 |
|---|---|---|
| AGENTS.md / CLAUDE.md | GitNexus 统计更新 | 工具元数据，不是功能变更 |
| hmi_service.py | draft 增加 mode=vision，可绕过 OCR | 已运行接口的 OpenAPI 有 mode；没有证明内存中的所有实现均与磁盘一致 |
| scripts/vlm_qwen.py | 默认 8000 FP8；OCR 有文字时默认文本请求，vision 或空文字时可看图；响应容错 | 与原来有图即看图的行为不同，影响模型对比基线 |
| scripts/extract_fields.py | 四个温区列头命中时优先路由 TACT | 在单图分类前执行，不验证列头空间顺序；需补跨控制器冲突样本 |
| templates/tact.temperature.json | 落下口增加“下口”别名 | 与上述路由共同作用 |
| tests/test_generic_extraction.py | TACT 正反例及候选测试命名更新 | 新增 TACT 测试已通过 |

用于后续确认同一工作树的 SHA-256：

```text
hmi_service.py                 537b0a8bfb4ae60d96ba173d15a3eaeef344cbdc2616f7187bcaa58b7095bd0b
scripts/extract_fields.py      1848717352f16e673e889b6a88c398f4ed31e1501c13502432c0e4a6852d1384
scripts/vlm_qwen.py            4064e10aacfe9809d28be6e14734d25e996f73404e67af7f7df1b268c3804101
templates/tact.temperature.json d915133ea812f0e36445a22678bb352b97e8d5ae3cc634972a725857c96941de
tests/test_generic_extraction.py 641851d34c4477b3bc651c856369d80501c4aa77659687c63a5c79e9a825248e
```

## 2. 验证结果与局限

| 检查 | 结果 |
|---|---|
| `.venv/bin/python -m pytest tests/test_generic_extraction.py tests/test_vlm_text_mapping.py -q` | 40 passed |
| `.venv/bin/python -m pytest tests -q` | 234 passed，27 subtests passed，2 条 FastAPI on_event 弃用警告 |
| `.venv/bin/python scripts/datasets.py check` | 111 cases，通过；calibration/holdout/regression = 62/46/3 |
| `git diff --check` | 通过 |
| `node .gitnexus/run.cjs analyze` | 完成，3,921 nodes / 6,751 edges / 213 flows |
| GitNexus detect_changes(all) | HIGH；12 个变更索引项、6 条直接关联流程、7 个文件 |
| route_family upstream impact | CRITICAL；2 个直接生产依赖，11 个受影响执行入口；直接依赖为 extract_one、process_hmi_image |
| draft_from_ocr upstream impact | 图谱 LOW / 0，但源码 draft_image 经 asyncio.to_thread 调用它；图谱未识别此动态依赖，不能按零影响理解 |

测试和数据集校验不等于用 111 张图重跑 OCR，也不等于测过 PaddleOCR-VL。

尚待收口：

1. `extract_fields.py` 已有改动从 1,427 行增加到 1,431 行，超过 workflow 1,000 行阈值且继续增长。下一次代码收口应处理这一点，不能将通过 pytest 当作全部工程门禁通过。
2. vision 显式分支缺专门回归；mode 非法值当前静默走默认路径。模型端点默认值变化、空值容错也需要锁定行为。
3. sources 缺失/假值会按模式补为 ocr/vlm，item 可继承 field 来源；这只是本地补值，不是逐项来源核验。field evidence 为空仍会被后续校验拒绝，不能宣称“空证据也已容错”。
4. vlm_qwen 顶部环境说明及部分错误文本仍写 8003 / 旧模型，与当前 8000 默认配置不一致。
5. 尚未执行真实图片端到端、Web 写入回读或源代码与运行进程版本一致性验证。本轮不把工作树命名为“已验收发布基线”。

## 3. 本机运行证据

- `.venv`：paddleocr 2.7.3、paddlepaddle-gpu 2.6.2；`init_ocr_engine` 使用 `PaddleOCR(...).ocr(...)`，不是 PaddleOCRVL。
- 8765 `/ready` 返回 ready；8000 `/v1/models` 返回 `Qwen3.8-27B-FP8`；8003 返回 `Qwen3.8-27B-AWQ-INT4`。这些是端点自报标识，不是权重身份独立验证。
- 2 张 A100 80GB，核验瞬间空闲分别为 2,526 / 9,134 MiB；显存随运行负载变化，不能仅凭 0.9B 参数量承诺能直接共驻或满足延迟。

## 4. 换成 PaddleOCR-VL 是否更好

结论：值得离线对比，尤其是未知布局、屏幕拍摄退化和行列归属；目前没有 HMI 实测证据支持直接替换主链。

官方当前文档已列出 VL 1.6；1.5 引入 text spotting（文字定位与识别），并对倾斜、屏幕拍摄等文档场景进行评测。1.6 继续改善文档解析。公开文档基准分数不能换算成注塑机 HMI 字段准确率；两个版本的不同 benchmark 分数也不应直接相减当作提升幅度。

| 问题 | 对本项目的判断（待实测） |
|---|---|
| 温区、段序、标签与值对应 | VL 表格/布局能力可能帮助，值得优先测 |
| 小数点、负号、密集小数字、摩尔纹 | 不能保证胜过 PP-OCRv4；必须逐数值精确核验 |
| 禁用段、设定/实际、压力侧别 | 仍需 HMI 语义与合同校验；换 OCR 不会自动解决 |
| 现有 text+bbox+confidence | VL 非原 API 替代；spotting 有定位能力，但需核实坐标及分数合同，不能伪造 confidence=1 |
| 性能 | 0.9B 相比 27B Qwen 更小，但不意味着比现有 PP-OCRv4 更快；需测完整链路 |

完整 VL 文档解析是“布局分析 + 分块 VLM 识别”；仅在 vLLM 启动 VLM 权重不等同完整 pipeline。对 HMI 可分别评测完整 pipeline 和 spotting，标清实际配置，避免用不完整部署否定或夸大模型。

官方 Paddle 后端安装路径使用 PaddlePaddle 3.2.1+ 和新版 doc-parser 包，不能直接在当前 2.6.2/2.7.3 环境原地升级；采用独立环境或固定版本容器，不动现有 8765、8000、8003。

## 5. 最小下一步

1. 先完成第 2 节的源码基线收口，再冻结 commit、依赖版本、模型配置及数据清单。
2. 使用现有 62 calibration 样本调试适配；46 holdout 保持封存，只在配置冻结后做最终评价。不得用 holdout 反复改 prompt/阈值再宣称独立验证。
3. 同图比较当前 OCR、固定版本 VL 1.6 spotting/解析；如衡量最终候选效果，下游 Qwen、合同与图像预处理保持可比，单列 OCR 层与最终字段层结果。
4. 至少记录数字精确匹配（含正负号、小数）、标签/角色/段序匹配、漏项/多项、整页正确率、错误放行数、拒识率、p50/p95 延迟和峰值显存；不可只比较生成的 Markdown 是否整齐。
5. VL 若主要改善困难样本，先用于失败重读/未知布局候选；只有常规 verified 样本不退化且错误放行、延迟与资源均达标，才考虑主链替换。有限样本零错误不能宣称普遍零错误。

## 官方来源（2026-09-07 查阅）

- [PaddleOCR-VL 使用与部署文档](https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/PaddleOCR-VL.html)
- [PaddleOCR-VL-1.5 官方模型卡：spotting、接口与依赖](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.5)
- [PaddleOCR-VL-1.6 技术报告](https://arxiv.org/abs/2606.03264)
