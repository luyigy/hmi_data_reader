---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: null
slice: null
plan_progress: complete
date: 2026-09-08
---

# 本轮交接：PaddleOCR-VL 试验收口与 9 月 7 日 PLAN 理解

## 1. 交接结论与范围

本轮完成了现有基线核验、PaddleOCR-VL-1.6 独立环境小样本试验，以及试验结束后的 Qwen 显存配额恢复。用户在 9 月 8 日明确决定：停用 PaddleOCR-VL，把显存还给 Qwen，继续使用现有 Paddle OCR。该决定已执行；VL 旁路仅保留为未来研究选项，没有上线。

下一阶段的优先级是 9 月 7 日 PLAN 的 Phase 1：用一个已 verified 的 profile 打通 `Reader Observation → Web ApplyPlan → before/after 预览 → 用户确认 → 安全写入与审计`。更换模型、Screen Graph、Agent fallback 都不应抢在这个闭环之前。

本文记录工作状态和对新计划的理解，不启动 workflow，不代表新 PLAN 已实施或完成。元数据中的 `completed / complete` 仅指本次交接整理完成；`plan: null` 表示本轮没有执行正式 Slice。新 PLAN 仍在 inbox，未补执行元数据、未派发。

证据分层：

- **本次复核**：2026-09-08 08:20（Asia/Shanghai）读取的文件、Git 状态、服务只读接口和 GPU 进程快照。
- **历史验证**：087 REPORT 记录的 9 月 7 日测试与基线检查，本次没有重跑。
- **试验报告/会话记录**：Antigravity 的 PoC 原报告及任务房间记录；本文未重新推理三张样本，未独立复现底层补丁和性能数据。

## 2. 关键资料入口

| 资料 | 用途 |
|---|---|
| [9 月 7 日新 PLAN](inbox/PLAN_20260907_HMI_Agentic识别与Web落盘架构.md) | 下一阶段架构方向，尤其第 13、16、18 节 |
| [087 基线核验与 VL 评估](087_REPORT_20260907_当前基线核验与PaddleOCRVL评估.md) | 既有未提交改动、测试、风险和实验前状态 |
| [082 通用候选协议](082_PLAN_20260825_通用HMI结构化候选协议.md) | 目录外字段可保留为候选的既有协议 |
| [086 HTTP 接线交接](086_HANDOVER_20260825_082S02_通用HMI候选HTTP接线完成.md) | `/api/v1/draft` 的候选边界与历史验证 |
| [PLAN/Slice 写作规范](083_DECISION_20260825_PLAN写作与Slice划分规范.md) | 后续将架构计划拆成可执行 Slice 的规则 |
| [workflow contract](workflow/workflow-contract.yaml) | 文档状态、编号、派发与工程门禁 |

PoC 原报告位于仓库外：`/home/hello/.gemini/antigravity-cli/brain/0c72cacd-8e72-4813-b154-da33038ac438/paddleocr_vl_poc_report.md`。本次已读取，核心结果在下文保留，避免交接完全依赖个人 Artifact 路径。

## 3. 本轮改动、尝试与最终状态

### 3.1 基线盘点：已有代码改动仍未收口

当前 HEAD 为 `4517951ec76683364e125d035ee0f7eec5b50caa`。7 个已跟踪文件仍有既有改动，合计 `+73/-30`，与 087 的记录一致；下表中 5 个业务代码/配置/测试文件的 SHA-256 均与 087 一致。

| 文件 | 087 核验的已有改动 | 当前交接处理 |
|---|---|---|
| `AGENTS.md`、`CLAUDE.md` | GitNexus 索引统计更新 | 原样保留 |
| `hmi_service.py` | draft 增加 `mode=vision`，可绕过 OCR | 尚未作为新发布基线验收 |
| `scripts/vlm_qwen.py` | 默认 8000 FP8；有 OCR 文本时默认文本请求；vision/空文本可看图；响应容错 | 需锁定端点、模式与来源补值行为 |
| `scripts/extract_fields.py` | 命中四个温区列头时优先路由 TACT | 需补跨控制器冲突验证 |
| `templates/tact.temperature.json` | 落下口增加“下口”别名 | 与 TACT 路由共同验收 |
| `tests/test_generic_extraction.py` | TACT 正反例与候选测试调整 | 历史测试已通过，不等同端到端验收 |

未跟踪资料包括历史 084 会话快照、087 REPORT 和 inbox 新 PLAN。084 中的旧 WORKFLOW_PROMPT 不是本轮指令。不要把这些既有变更归为 VL 试验修改，也不要把整个工作区直接打包提交。

### 3.2 VL 独立环境与显存试验

据 PoC 报告，试验使用 GPU 1、单图单并发：

- 新建 `.venv-paddleocr-vl`，Python 3.10.12，`paddlepaddle-gpu 3.2.1.post126`、`paddlex 3.7.2`、`paddleocr 3.7.0`，模型标识为 `PaddleOCR-VL-1.6-0.9B`。
- 保留原 `.venv`、现有 8765 Paddle 服务与 `vllm2`；报告称未改生产识别代码、未使用 holdout 调参。本次确认独立环境目录仍存在，但未重新盘点安装版本或模型权重。
- GPU 1 初始仅约 9 GiB 空闲，Paddle 启动/前向发生 OOM。为试验将 8003 Qwen 服务的 `--gpu-memory-utilization` 从 `0.90` 调至 `0.78`，服务文件备份为同路径 `.bak`。
- 调整后报告记录 Qwen 占用 61,757 MiB，GPU 1 空闲 20,163 MiB。这是试验期间状态，已经失效，不能据此安排当前 VL 共驻。
- 会话记录称排查了生成过程的 KV cache 与 `paddle.no_grad()` 使用，并在评测工具中使用原生缓存驱动解码；还尝试 `repetition_penalty=1.15～1.20` 缓解重复生成。此为本地试验描述，没有上游修复提交或独立复现证据，不作为已证实的官方缺陷结论。

### 3.3 三张样本的结果

以下是原报告结果，属于探索性 PoC，不是完整数据集验收。

| 样本 | 尝试与结果 | 交接判断 |
|---|---|---|
| Demag：`barrel_A02_b24ff33d.jpg`，`demag.temperature.screen_order_5` | 输出结构化表格；报告列出的设定/实际温度 `[350,295,290,285,60]`、偏差、控制百分比、油温等均匹配；总耗时 4.27 s | 支持“此样本表格结构恢复有效”，不能推广为该家族或全场景 100% |
| Omron E5CC：`mt_front_A04_f69799e9.jpg` | 真值 PV/SV 均 40.0；全图输出 `8890/8888`，局部裁切输出 `8.840 PV / 8.898 SV`；全图总耗时 0.85 s | 数码管困难样本未解决；暗段反光是报告的原因解释，尚无受控实验隔离证据 |
| TRD6：`inj_Z020_20250428_rank04_recuQJJFYYoL7p.png` | 部分时间/转速字段正确；V-P 数字框切片（会话记录坐标 x=415～620、y=220～290）仍只读到 `L` 或 `mm`，漏掉真值 10.0；全图总耗时 3.79 s | 历史 SAFE_REJECT 根因未攻克，不应提升为可自动写入 |

资源与性能数字的使用限制：

1. 原报告汇总称 VL 为 3.7～7.2 s，但样本表有 0.85 s；现有材料不足以统一其统计范围。交接采用逐样本数字，不引用统一倍数为验收结论。
2. 部分行的 Alloc 大于 Reserved，未说明采样时点、统计域和单位。7.6～10.6 GiB 只能作为报告给出的资源量级，峰值口径需核实。
3. PP-OCRv4 的 40～120 ms、20～50 QPS，以及“替换后吞吐下降 98%”“仅支持 1～2 并发”等说法缺少本次可核对的同配置压测记录，不能作为容量承诺。
4. 没有完整 calibration/holdout 评测、p50/p95、false-green 或真实 Web 写入验证。输出整齐的 Markdown 也不等于满足现有 `text+bbox+confidence` 接口合同。

### 3.4 用户决定与服务恢复

9 月 8 日 08:14 用户决定停止 VL、归还显存、继续现有 Paddle。08:17 的 Codex 交接记录：VL 评测进程当时已经退出；从备份恢复 Qwen 配额至 `0.90` 并重启，8003 模型接口和实际生成测试通过，约收回 9.5 GiB 显存。

本次 08:20 只读复核结果：

| 项目 | 当前结果 |
|---|---|
| Qwen 服务文件 | `/home/hello/.config/systemd/user/vllm-Qwen3.8-27B-AWQ-INT4.service`，实际启动参数 `--port 8003 --gpu-memory-utilization 0.90 --max-model-len 131072` |
| systemd | `vllm-Qwen3.8-27B-AWQ-INT4.service` 为 `active` |
| `http://localhost:8003/v1/models` | 正常返回 `Qwen3.8-27B-AWQ-INT4`，`max_model_len=131072` |
| `http://localhost:8765/ready` | `{"status":"ready"}` |
| GPU 计算进程 | 两个 VLLM EngineCore，另有原 `.venv/bin/python3.10` 占用 732 MiB；快照未见 VL 评测环境进程占用 GPU |
| 环境与备份 | `.venv-paddleocr-vl` 和 Qwen `.service.bak` 仍存在 |

本次未再次生成模型回答或重启服务。服务配置注释仍提到 64K，但实际启动参数与模型接口为 131072，应以生效值为准。8003 配额恢复也不代表 Reader 的默认模型端点改回 8003；087 记录的工作树默认值仍是 8000。

## 4. 对 9 月 7 日新 PLAN 的理解

### 4.1 解决的是识别到业务写入的完整合同

新 PLAN 保留已有 OCR、profile、质量门禁和 contract，在其外增加编排与安全写入边界。识别出数字只是感知结果；单位、角色、段序、启用状态、压力侧别、时间定义等确认后，才能形成可消费的 canonical observation。

职责划分：

- Reader 维护字段语义事实源，输出观察、元数据、证据与 review/reject 状态，不生成 Web 内部 `parameter_data` 或直接写 Trial。
- Web 消费冻结并 pin 版本的 contract 快照，负责目标字段映射、当前 Trial 结构检查、ApplyPlan 预览、提交和审计，不 runtime import Reader。
- 已知 verified profile 继续走确定性主链。未知控制器/页面/变体、布局模糊、字段或多图冲突、低 OCR 置信度等才进入 fallback；Agent 不能绕过合同把不确定值标 safe。
- 多图按 Session/Record 聚合，校验跨页的一致性；已有 controller 聚合可作为基础，但不等同新 session 合同已完成。

### 4.2 与 082 通用候选协议的衔接

082 已交付的 `sections/fields/items` 允许目录外字段以 `canonical_id: null` 保留，且候选需要确认；新 PLAN 规定 canonical `fields` 只能使用 Field Catalog 中已有 key。二者处于不同阶段，建议这样衔接：

1. 保留通用候选层对新字段的观察能力，避免重新把识别范围锁死在温度/射胶/保压等少量字段上。
2. 进入正式 HMIObservation 的 canonical `fields` 前，校验字段目录和物理语义；未登记字段保留为未映射候选/复核信息，不伪造 canonical key，不进入 safe ApplyPlan。
3. 确需支持新的业务字段时，更新 Reader 字段合同与版本，再由 Web 更新冻结快照及目标映射；仅有新字段的 OCR 文本不构成自动写入授权。

这是本次对两个计划的兼容建议，尚未定义最终 schema 或实现转换器；目录外候选在新 envelope 中的具体承载位置应在 Phase 1 合同设计时明确。不能直接把 `/api/v1/draft` 现有响应命名为新 HMIObservation，也不能无声删除其目录外字段能力。

### 4.3 四个阶段及实施顺序

| 阶段 | 交付重点 | 本轮状态 |
|---|---|---|
| Phase 1：固化边界 | 版本化 Observation、contract 校验、Web ApplyPlan、预览、safe commit、审计；一个 verified profile 闭环 | 下一步优先，未实施 |
| Phase 2：Layout / Screen Graph | 行列、grid、label 关系、enabled/disabled、layout signature 与 similarity | 架构方向，未实施 |
| Phase 3：Agent fallback | 使用 OCR/图像证据、profile 检索、字段目录和验证器输出受限候选 | 不因完成 VL PoC 就视为交付；具体模型未定 |
| Phase 4：学习闭环 | 人工纠正 → 真值 → candidate profile → calibration/holdout → verified | 需要真实验收与晋级依据，未实施 |

三个 Agent 是逻辑职责，不要求三个独立进程。VL 试验被停止不阻断 Phase 1，也不否定未来 fallback；新 PLAN 没有要求使用 PaddleOCR-VL。

关键成功指标是错误自动写入率，而非单纯 OCR 置信度或候选数量。“错误自动写入率 = 0”是目标；有限样本零错误不能证明生产永远零错误。

## 5. 后续接手顺序与验收建议

1. **先确认工作区基线。** 对照 087 与本文的 HEAD/哈希，区分已有功能变更和部署状态。087 记录的 `route_family` upstream 为 CRITICAL（2 个直接生产依赖、11 个受影响执行入口）；后续编辑前重新跑 GitNexus impact 并报告风险，不能沿用过期图谱结论。
2. **收口已知缺口。** 包括 vision 分支/非法 mode/默认端点/来源补值的行为验证、TACT 跨控制器冲突、`extract_fields.py` 超过 1000 行门禁，以及源码与运行进程的一致性。这些是 087 已识别的待办，尚未完成。
3. **按新 PLAN 第 16 节做双仓调查。** 阅读双方 AGENTS、workflow、field catalog、profiles、Reader 响应、Web 冻结合同与 Trial 写入入口。本文没有审计 Web 当前实现，不能宣称其 ApplyPlan 或审计功能已具备。
4. **形成 Phase 1 最小可执行 Slice。** 优先复用现有接口/验证器，以一个已 verified profile 定义 Observation 和 ApplyPlan 的最小变更，按 083 补目的、产物、实现、边界、验收、停止条件和交付物；本次不改 inbox PLAN 的触发状态。
5. **验收成功和拒绝路径。** verified 样本经合同生成精确目标的 before/after，用户确认后写入并回读、留审计；版本不匹配、单位/压力侧别不明、段数或段序冲突、目标不存在、识别期间 draft 已变化时必须阻止不安全提交。明确 review 项如何逐项确认，避免整页状态覆盖字段风险。

数据纪律沿用 087：calibration/holdout/regression 为 62/46/3（共 111 cases，历史清单检查）；holdout 保持封存，配置冻结后再做独立评测。本文没有读取 holdout 图片或重跑识别。

## 6. 验证记录、问题与本次文件改动

历史验证（来自 087，未在本次重跑）：聚焦测试 40 passed；全量 234 passed、27 subtests passed、2 条既有 FastAPI 弃用警告；数据清单 111 cases 通过。这些结果不代表 VL 或 Web 端到端通过。

本次完成：读取新 PLAN 全文及上述交接/评测资料；复核 5 个文件哈希、Git 差异统计、Qwen 配额/上下文、8003 模型接口、8765 ready 和 GPU 进程快照。

仍存在的证据问题：

- PoC 报告称脚本位于 `scratch/`，但当前项目根目录不存在该目录，无法在此核对或复跑评测脚本。独立环境仍在不等于试验可复现；未来若重启试验，先找回脚本、原始输出、完整启动参数与指标口径。
- 显存 Alloc/Reserved、时延区间和吞吐推断的口径问题见第 3.3 节；本文没有把它们作为已验收指标。
- 现有未提交代码尚未收口、新 PLAN 尚未实施、Web 侧未核验；均不阻塞本次交接文档完成。

本次只新增 `docs/088_HANDOVER_20260908_PaddleOCRVL试验收口与0907PLAN理解.md`；未修改生产符号、依赖、服务配置或新 PLAN，未暂存/提交既有变更。前一轮运行环境的实际修改是 Qwen 用户级 systemd 服务配额先降后恢复，独立 VL 环境和报告留存于磁盘。
