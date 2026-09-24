# HMI Agentic 识别与 Web 落盘架构计划

> 目标：把 `hmi_data_reader` 从“固定模板 + OCR 的识别器”升级为“确定性主链 + Agent fallback + 契约驱动落盘”的 HMI Understanding Pipeline，并与 `mold-data-webpage-tool` 稳定集成。
>
> 适用仓库：
> - `luyigy/hmi_data_reader`
> - `luyigy/mold-data-webpage-tool`
>
> 日期：2026-09-07

---

## 1. 背景与核心问题

用户通过手机拍摄注塑机 HMI 页面，希望自动识别工艺参数并写入 `mold-data-webpage-tool`。

过去的实践说明，真正的难点不是单纯 OCR，而是两个问题同时存在：

1. **HMI 变体爆炸**
   - 不同注塑机品牌使用不同控制器；
   - 同一品牌可能使用 KEBA、B&R、弘讯、EST、FANUC 等不同 HMI；
   - 同一控制器不同版本布局可能变化；
   - 同一页面还可能存在 4 段、5 段、6 段、7 段等动态结构；
   - 禁用段、报警态、浅色/深色主题等会进一步改变画面。

2. **识别结果如何可靠落到业务数据模型**
   - OCR 识别出 `80 / 60 / 40` 并不等于知道它们是什么；
   - 必须确认它们是射胶速度、保压压力还是背压；
   - 必须确认段序、单位、压力侧别、时间定义等物理语义；
   - 最后还要映射到 `mold-data-webpage-tool` 当前 Trial 的实际数据结构。

因此，本项目的目标不应再定义为：

```text
Image -> OCR -> JSON -> DB
```

而应定义为：

```text
Image
  -> Perception
  -> HMI Observation
  -> Semantic Contract
  -> Apply Plan
  -> User/Rule Validation
  -> Commit
```

---

## 2. 当前仓库已经具备的基础

### 2.1 `hmi_data_reader`

当前已经具备：

- 图片 SHA-256 去重；
- 质量门禁；
- 屏幕检测与透视矫正；
- PaddleOCR 输出 `text + bbox + confidence`；
- UI family / page classification；
- record 级 controller 聚合；
- profile / template；
- 字段级真值；
- `contracts/field_catalog.json`；
- `contracts/profiles.json`；
- verified / candidate profile 生命周期；
- `field_meta`、`physical_semantics`、`web_target`；
- 数值提取、warning、ok/review/reject；
- 已验证部分控制器 / 温度页 / 注射页 / 保压页等布局。

这意味着不应该推翻现有 pipeline，而应在它外部增加 Agentic orchestration。

### 2.2 `mold-data-webpage-tool`

当前已经具备：

- `contracts/hmi-reader/` 契约冻结快照；
- Web 侧不 runtime import reader；
- HMI contract 版本 pin；
- reader 维护字段事实源，Web 只消费冻结版本；
- 已存在 `web_target_rules`，负责把 reader canonical field 映射到 Web 数据结构。

这个 repo 边界应继续保留。

---

## 3. 总体设计原则

### 3.1 Agent 不直接写数据库

Agent 可以：

- 判断页面；
- 识别布局；
- 解释字段关系；
- 对未知变体进行推理；
- 找相似 profile；
- 给出候选 canonical fields；
- 发现冲突和异常。

Agent **不能**：

- 随意发明字段名；
- 直接输出 Web 内部数据结构；
- 绕过 contract；
- 直接 commit 到 Trial；
- 在单位、段序、压力侧别不确定时强行自动写入。

### 3.2 确定性主链，Agent 只做 fallback

生产主链：

```text
known profile
  -> deterministic parser
  -> validator
  -> canonical observation
```

只有出现以下情况才调用 Agent：

```text
UNKNOWN_CONTROLLER
UNKNOWN_PAGE
UNKNOWN_VARIANT
LOW_LAYOUT_SIMILARITY
AMBIGUOUS_STAGE_STRUCTURE
FIELD_CONFLICT
OCR_LOW_CONF
MULTI_IMAGE_CONFLICT
```

### 3.3 Canonical Observation 与 Web 数据结构解耦

Reader 输出的是“我观察到什么”，不是“数据库应该怎么存”。

错误示例：

```json
{
  "parameter_data": {
    "injection": {
      "segments": [...]
    }
  }
}
```

正确方向：

```json
{
  "fields": {
    "stage_velocity_mms": [80, 60, 40],
    "stage_position_mm": [130, 70, 30],
    "switch_position_mm": 10,
    "injection_pressure_limit_bar": 950
  }
}
```

然后由 contract 决定如何映射到 Web。

---

## 4. 推荐系统架构

```text
                   HMI Photos
                       |
                       v
            +---------------------+
            | 1. Image Intake     |
            | dedup / quality     |
            | crop / rectify      |
            +----------+----------+
                       |
                       v
            +---------------------+
            | 2. Perception Layer |
            | OCR + bbox          |
            | layout / grid       |
            | UI visual state     |
            +----------+----------+
                       |
                       v
            +---------------------+
            | 3. Router           |
            | controller family   |
            | hmi variant         |
            | page type           |
            | profile similarity  |
            +----------+----------+
                       |
               +-------+-------+
               |               |
               v               v
        Known Profile      Unknown / Ambiguous
               |               |
               v               v
      Deterministic        Agent Fallback
        Extractor          + Retrieval
               |               |
               +-------+-------+
                       |
                       v
          +--------------------------+
          | 4. Semantic Normalize    |
          | canonical fields         |
          | units / entity / order   |
          | physical semantics       |
          +------------+-------------+
                       |
                       v
          +--------------------------+
          | 5. Verification          |
          | range / count / unit     |
          | stage structure          |
          | cross-image consistency  |
          +------------+-------------+
                       |
                       v
               HMIObservation
                       |
                 HMI Contract
                       |
                       v
          +--------------------------+
          | mold-data-webpage-tool   |
          | Observation -> ApplyPlan |
          | ApplyPlan -> Commit      |
          +--------------------------+
```

---

## 5. Layout Layer：不是传统文档 OCR

HMI 与 PDF/发票类文档不同。

需要识别的不只是文本，还包括：

- 行 / 列；
- 表格 / grid；
- Tab；
- 输入框；
- 单位标签；
- 数值与 label 的邻接关系；
- stage 顺序；
- enabled / disabled 视觉状态；
- 深色背景、浅色背景；
- 报警态；
- 局部图标；
- 同一组数值的结构关系。

因此推荐把 OCR 输出升级为更结构化的 Screen Graph。

示例：

```json
{
  "nodes": [
    {
      "text": "80",
      "bbox_norm": [0.62, 0.32, 0.67, 0.36],
      "row": "injection_speed",
      "column": "segment_2",
      "nearby_labels": ["射出速度", "V2"],
      "unit_context": "mm/s"
    }
  ]
}
```

这层可以由以下组合实现，而不是绑定某一个模型：

```text
OCR
+ geometry grouping
+ row/column detection
+ grid detection
+ UI component detection
+ image-state observation
```

---

## 6. HMI Profile 的定位

不要再把模板理解为“某个品牌某张图的绝对坐标模板”。

Profile 应描述一个可复用的 HMI 布局语义。

建议 Profile 包含：

```yaml
profile_id: b_and_r.temperature.fixed7

controller_family: B_AND_R
page_type: temperature

layout_signature:
  columns: 7
  headers: [NZ, "#1", "#2", "#3", "#4", "#5", "#6"]

extractor:
  type: grid

fields:
  barrel_temperature_set_c:
    row_semantics: set_temperature

lifecycle:
  status: verified
  sample_count: 18
```

Profile 的作用：

- 给 deterministic parser 提供稳定规则；
- 给 Agent 提供已知布局知识；
- 给 unknown layout 提供相似度检索目标；
- 管理 candidate -> verified 生命周期。

---

## 7. Agentic Pipeline 的三个逻辑角色

这里的“Agent”不一定意味着三个独立进程，也可以是一个 orchestrator 中的三个阶段。

### 7.1 Perception Agent

职责：

- 判断这是什么页面；
- 哪些数字属于一组；
- 哪个值对应哪个 label；
- 判断 layout 是否与已知 profile 接近；
- 发现 OCR 可能错位的位置。

输入：

```text
image
ocr tokens
bbox
screen graph
profile candidates
```

输出：

```text
screen observations
```

### 7.2 Semantic Agent

职责：

- 将 HMI 上的 UI 表达映射到 canonical fields；
- 解释“速度 / 位置 / 压力 / 时间”的业务语义；
- 判断段序；
- 判断时间是 duration 还是 cumulative；
- 判断压力侧别；
- 从 `field_catalog` 中选择字段。

硬约束：

> Agent 只能从 Field Catalog 中选择已有字段，不得发明新字段。

如果没有合适字段：

```text
status = unsupported_semantics
```

而不是猜。

### 7.3 Verification Agent

职责：

- 数值合理性；
- 单位一致性；
- 数组长度；
- Trial 当前段数；
- stage enabled；
- 跨图一致性；
- 压力侧别；
- 页面之间的物理关系。

示例：

```text
screen: 5 injection stages
trial draft: 4 injection stages
=> block auto apply
```

```text
OCR value: 2900 °C
expected field: barrel temperature
=> suspect OCR error
```

```text
screen says bar_spez
trial pressure_basis = plastic
=> compatible
```

最终给出：

```text
GREEN   safe to auto apply
YELLOW  needs review
RED     reject / retake
```

---

## 8. 多图必须按 Session / Record 聚合

单张图片不应该是最终识别上下文。

推荐新的处理单位：

```text
trial_hmi_capture_session
```

一个 session 可以包含：

```text
temperature.jpg
injection.jpg
holding.jpg
metering.jpg
monitor.jpg
```

聚合价值：

- 某张图有 Logo，其他图没有；
- 可以共享 controller_family；
- 可以共享 hmi_variant；
- 页面之间可以交叉验证；
- stage 数量可以互相校验；
- 压力单位 / 压力侧别可共享；
- 用户上传错图更容易发现。

因此 API 不应长期停留在：

```text
/image/read
```

推荐逐步升级成：

```text
/hmi-sessions
/hmi-sessions/{id}/images
/hmi-sessions/{id}/analyze
```

具体 API 形态可根据当前服务风格调整，本计划不强制 REST 命名。

---

## 9. Canonical HMIObservation 建议结构

建议定义一个正式、版本化 schema。

示例：

```json
{
  "schema_version": "1.0.0",
  "session_id": "...",
  "controller_family": "B_AND_R",
  "hmi_variant": "fixed7",
  "page_type": "injection_metering",
  "profile_id": "b_and_r.injection_metering.xxx",
  "profile_status": "verified",
  "fields": {
    "stage_velocity_mms": [80, 60, 40],
    "stage_position_mm": [130, 70, 30],
    "switch_position_mm": 10,
    "injection_pressure_limit_bar": 950
  },
  "field_meta": {
    "stage_velocity_mms": {
      "unit": "mm/s",
      "entity": {
        "kind": "injection_segment",
        "order": "physical_stage"
      }
    }
  },
  "warnings": [],
  "evidence": [],
  "confidence": {
    "controller": 0.99,
    "page": 0.98,
    "layout": 0.95,
    "fields": {}
  },
  "status": "ok"
}
```

注意：

- `fields` 只允许 Field Catalog 中的 key；
- `field_meta` 由 contract attach / merge；
- `evidence` 可以记录 bbox、crop、OCR token、原图引用；
- `status` 不应只看 OCR confidence，还要看 semantic / structure validation。

---

## 10. Web 侧必须引入 Apply Plan

不要：

```text
Observation -> 直接写 Trial
```

必须：

```text
Observation
  -> Apply Plan
  -> Preview / Validation
  -> Commit
```

Apply Plan 示例：

```json
{
  "items": [
    {
      "source_field": "stage_velocity_mms[0]",
      "target": "parameter_data.injection.segments[0].speed.raw_value",
      "old_value": 75,
      "new_value": 80,
      "unit": "mm/s",
      "status": "safe"
    },
    {
      "source_field": "switch_position_mm",
      "target": "parameter_data.injection.vp_switch.position.raw_value",
      "old_value": 12.4,
      "new_value": 12.5,
      "unit": "mm",
      "status": "review"
    }
  ],
  "safe_count": 1,
  "review_count": 1,
  "blocked_count": 0
}
```

Apply Plan 生成时必须检查：

- contract version；
- target rule；
- Trial 当前段数；
- 单位；
- pressure basis；
- target 是否存在；
- draft 是否在识别期间发生变化；
- 数组长度；
- stage order；
- special transform rule；
- 写入后是否破坏当前数据结构。

---

## 11. Web UI 推荐交互

用户在某次 Trial 中上传 HMI 图片后，看到：

```text
控制器：B&R
页面：温度 / 注射 / 保压
识别字段：38
安全字段：35
需确认：3
阻止写入：0
```

字段级展示：

```text
射胶

             当前值      HMI识别
段1速度      80          82 mm/s
段2速度      55          55 mm/s
段3速度      35          35 mm/s

V/P位置      12.4        12.5 mm
```

用户操作：

```text
[查看原图证据]
[应用所有安全字段]
[逐项确认 3 个字段]
```

原则：

- 自动识别结果默认可见；
- 所有改写有 before / after；
- 可以查看原图证据；
- 可以知道为何被判 yellow/red；
- 所有 commit 有 audit trail。

---

## 12. 新布局学习闭环

系统必须把 unknown 当作正常状态，而不是异常失败。

推荐闭环：

```text
Unknown Layout
   |
   v
Agent interpretation
   |
   v
Human review
   |
   v
Ground Truth
   |
   v
Similarity cluster
   |
   v
Candidate Profile
   |
   v
Validation dataset
   |
   v
Verified Profile
   |
   v
Future deterministic parsing
```

目标不是让 Agent 永久识别所有页面。

目标是：

> Agent 负责发现和理解新布局，成熟后把它“固化”为 deterministic profile。

这样系统会随着使用越来越稳定、越来越便宜。

---

## 13. 建议实施阶段

### Phase 1 — 固化边界，不改识别能力

目标：先解决“识别结果如何可靠落盘”。

任务：

1. 定义 `HMIObservation` schema；
2. 规定 Field Catalog 是 canonical field 唯一事实源；
3. Reader 输出兼容新的 Observation envelope；
4. Web 新增 Observation -> ApplyPlan；
5. Web 实现 ApplyPlan preview；
6. Web 实现 safe commit；
7. 写 audit log；
8. 不新增新的 Agent 模型。

验收：

- 已有 verified profile 的结果可以通过 Observation -> ApplyPlan -> Commit；
- 不允许 reader 直接写 Web model；
- 不允许 Agent 或 parser 绕过 contract。

### Phase 2 — Layout / Screen Graph

目标：降低对固定坐标模板的依赖。

任务：

1. 基于屏幕矫正图增加 layout graph；
2. 识别 row / column / grid / label relation；
3. 保留 visual state，例如 enabled / disabled；
4. profile 增加 layout signature；
5. 计算 profile similarity。

验收：

- 同一 profile 在不同拍摄距离、透视、分辨率下仍可稳定路由；
- 对轻微布局变化可以识别成同 profile 或 near-profile，而不是直接 unknown。

### Phase 3 — Agent Fallback

目标：只解决未知 / 模糊布局。

Agent tools 最少包括：

- OCR result；
- layout graph；
- image crop；
- profile search；
- field catalog；
- contract semantics；
- range validator；
- historical reviewed cases。

Agent 输出必须受 JSON schema 和 Field Catalog 约束。

验收：

- 已知 profile 默认不调用 Agent；
- unknown layout 可以得到可解释候选；
- Agent 不能产生 Catalog 外字段；
- 不确定时必须 review/reject，不能强行 green。

### Phase 4 — Learning Loop

目标：让 Agent 的成功案例沉淀成新 profile。

任务：

1. 人工复核 UI；
2. 保存 corrected observation；
3. 保存 ground truth；
4. 聚类相似 unknown；
5. candidate profile generation；
6. calibration / holdout；
7. lifecycle promotion；
8. verified 后进入 deterministic fast path。

---

## 14. 不建议当前做的事情

当前不要优先：

- 把所有图片直接交给一个 VLM 输出最终 JSON；
- 用 LLM 直接生成 `parameter_data`；
- 删除现有 profile / contract 体系；
- 大规模重写 OCR pipeline；
- 为每个 HMI 页面写一个独立硬编码 parser；
- 通过机器品牌直接选择模板；
- 只用 OCR confidence 决定自动写入；
- 在没有 ground truth 的情况下宣布识别准确率提升；
- 让 unknown 自动映射到“最像的字段”。

---

## 15. 关键验收指标

后续所有改动建议都围绕以下指标：

### Reader 指标

- controller classification accuracy；
- page classification accuracy；
- field completeness；
- numeric accuracy；
- semantic mapping accuracy；
- layout routing accuracy；
- unknown recall；
- false-green rate。

### Web Apply 指标

- safe field apply accuracy；
- wrong target rate；
- wrong unit apply rate；
- wrong stage order rate；
- wrong pressure-basis apply rate；
- apply-plan reproducibility；
- commit audit completeness。

最重要的生产指标：

```text
错误自动写入率 = 0
```

宁可 yellow，也不要错误 green。

---

## 16. Coding Agent 开工顺序

Coding Agent 不要一开始就改模型或写 Agent。

建议按以下顺序调查：

1. 阅读两个 repo 的 `AGENTS.md`；
2. 阅读 workflow contract；
3. 阅读 `hmi_data_reader/contracts/field_catalog.json`；
4. 阅读 `hmi_data_reader/contracts/profiles.json`；
5. 阅读 reader 当前 service response schema；
6. 阅读 `mold-data-webpage-tool/contracts/hmi-reader/README.md`；
7. 找 Web 当前 HMI contract 消费逻辑；
8. 找当前 Trial `parameter_data` 的数据结构与写入入口；
9. 找当前已有 HMI recognition / import UI；
10. 先提出 Observation -> ApplyPlan 的最小变更方案；
11. 不直接编码 Agent fallback，先完成 Phase 1。

---

## 17. 给 Coding Agent 的任务约束

### 必须保持

- reader contract 是字段语义事实源；
- Web 使用冻结快照；
- contract versioning；
- profile lifecycle；
- deterministic fast path；
- unknown / review / reject 状态；
- auditability。

### 不允许

- runtime import reader repo；
- submodule 强耦合；
- Web 硬编码 reader 字段语义；
- reader 硬编码 Web DB column；
- LLM 直接数据库写入；
- 绕过 Apply Plan；
- 把低置信度自动升级成 safe。

---

## 18. Phase 1 推荐最小目标

如果只做一个最小、可合并的第一阶段，建议定义为：

> **让一个已经 verified 的 HMI profile，从 reader 输出 canonical observation，经 Web contract 生成 Apply Plan，在 UI 中预览 before/after，并由用户点击后安全写入当前 Trial。**

只要这个闭环跑通，后续 Layout Reader、Agent fallback、新 profile 学习都可以在不破坏 Web 数据模型的前提下逐步增加。

这应作为下一阶段的第一优先级。

---

## 19. 一句话架构结论

```text
不要让 AI 直接“看图填数据库”。

让 AI / OCR / Layout 负责理解屏幕，
让 Contract 负责定义语义，
让 Apply Plan 负责安全落盘，
让人工反馈把未知布局逐步固化成 Verified Profile。
```
