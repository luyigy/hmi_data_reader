# HMI Reader 页面识别与字段提取插件架构规范 v1.0

> 状态：**目标架构 / 约束性设计提案**，不是现有代码已经全部实现的声明。  
> 基线：`luyigy/hmi_data_reader`，`deploy/yizumi-auto-page`，提交 `cdc3469cbfebdb7b086a7bff7eeca8534ed3efe6`（2026-10-30）。  
> 面向：Architect、Implementor、Reviewer，供多品牌、多页面并行开发时共同遵循。  
> 范围：图片→页面身份→布局结构→字段→模型映射。暂不建设 TrialCam 品牌字典集成、机台主数据同步和新的识别模型。

## 1. 决策摘要（必须遵守）

1. **观测和解释分离**：公共视觉代码仅报告检测到的证据及坐标，不决定业务字段或段位。
2. **页面身份和字段读取分离**：路由识别的是具体页面模板，不是“品牌猜测”；已确定的模板不能被字段识别失败抹掉。
3. **布局先建逻辑结构，再证据核验**：边框、OCR 和段号共同验证行列及字段映射；单个漏框不必导致整组字段清空，未确认的段位不得自动导入。
4. **允许拒绝**：未知、歧义、不支持为合法结果，不能用相似模板强行读取。
5. **变化条件不能成为页面身份**：启用段数、灰显、数值大小、工艺设定、`5/4/4` 等都属于页面状态，不是模板身份。
6. **局部结构优先**：不依赖固定整屏坐标、标题错字、数据集文件名；裁剪后保留充分证据就可以识别。
7. **先局部，后共享**：不同控制器的结构语义由页面插件定义，只有有跨品牌证据证明可复用时才上升为公共模块。
8. **兼容优先、迁移渐进**：尚未迁移的旧模板继续可用，新插件注册后其页面身份必须由新路由裁决。

## 2. 目标数据流

```text
照片 / 上传请求
      │
      ▼
[0] 质量检查、屏幕定位/矫正、OCR（保留 OCR 文本、置信度、bbox）
      │
      ├───────────────►[1] 公共视觉证据提取
      │                  直线、边框候选、矩形、箭头/符号候选等
      │                  （不赋业务语义，可按需懒加载）
      │                            │
      └────────────────────────────┤
                                   ▼
[2] 页面身份路由 (page_identity)
    识别候选控制器族 → 具体页面 profile_id
    证据、缺失、互斥、未知/歧义/不支持
                                   │ matched
                                   ▼
[3] 页面布局重建 (page-specific layout)
    根据该 profile 的段轴/行列/值区规则建立逻辑结构
    将检测到的边框与 OCR 坐标绑定到逻辑格
    验证段号、错列、行标签；必要时生成有证据的候选格
                                   │
                                   ▼
[4] 页面字段提取 (page-specific extractor)
    字段语义、单位、段号、设定/实际、置信与核验状态
                                   │
                                   ▼
[5] 统一 Model/契约映射与核对
    输出结构化工艺数据；不确定数据进入人工核对
```

**关于顺序的裁决**：`visual_cells.py` 属于 **路由之前可用的公共证据层**，但不强制每张图先运行所有边框检测。路由按需使用轻量视觉证据；**精细布局重建在路由确定 profile 之后**。对于德马格这类非矩形表，公共层还应允许线条/箭头/复选框证据，而不强制经过 `visual_cells.py` 的矩形结果。

## 3. 分层职责与禁止事项

| 层 | 责任 | 不能做 |
|---|---|---|
| 0 图像/OCR | 图像质量、矫正、OCR 文本/框/置信；允许裁剪重试 | 根据数值猜模板或段位 |
| 1 公共视觉 (`visual_cells.py` 等) | 观察真实边界、线段、候选格、视觉证据；可返回弱/缺失证据 | 确定 B&R 保压第一段，删除 OCR 字段，写业务规则 |
| 2 页面路由 (`page_identity.py`, `*_page_identity.py`) | 插件比较，确认 `profile_id` 或拒绝；输出证据与冲突 | 判断启用段数、提取工艺值、把弱候选强行确认 |
| 3 页面布局 (`*_layout.py`) | 每个 profile 的行/列/段轴逻辑结构、几何关联、段号核验、可解释缺框重建 | 把 OCR 预测位置当成已验证事实、改变模板身份 |
| 4 字段提取 (`*_injection.py` 等) | 将已定位 OCR 读数映射字段、保留 raw 与 validated 状态 | 因一个格失败而清除所有原始 OCR，静默输出错段位 |
| 5 契约/Model | 标准字段、单位、source/state、业务校验、人工确认 | 以成功导入结果反证模板身份 |

## 4. 页面身份粒度

`machine_brand`（机台品牌）≠ `controller_family`（控制器族）≠ `profile_id`（具体页面/布局版本）。

- 示例：BOLE → B_AND_R → `b_and_r.injection_holding.multi_stage_position_time`；同家族的温度、储料、工艺监控未来均应另设相应 profile。
- 日精 TACT/TACT5 有共用局部结构：只看到充填区可给出 family 候选，但不得强定 TACT5 子页。
- 允许一个物理画面包含多个工艺区域；`profile_id` 是整个页面身份，布局和字段层可进一步划分 `section`。
- `machine_brand` 将来可作为来自 TrialCam 的**可选候选过滤提示**；当前继续遍历注册的结构路由插件。后续品牌主数据优先来自 `mold-data-webpage-tool`，不在 Reader/TrialCam 各建一套词典。

## 5. 插件契约（目标接口；非当前现成 API）

```python
@dataclass
class Evidence:
    kind: str                # text_label / row_order / stagger / border / arrow / stage_header ...
    source_ids: list[str]    # OCR token IDs / contour IDs；可回溯图像位置
    note: str

@dataclass
class PageCandidate:
    profile_id: str
    controller_family: str | None
    status: str              # matched / partial / rejected
    evidence: list[Evidence]
    missing: list[str]
    conflicts: list[str]

class PageIdentityPlugin(Protocol):
    profile_id: str
    def assess(self, observations) -> PageCandidate: ...

class LayoutPlugin(Protocol):
    profile_id: str
    def build(self, observations, candidate: PageCandidate) -> 'LayoutResult': ...

class FieldExtractor(Protocol):
    profile_id: str
    def extract(self, layout: 'LayoutResult', observations) -> 'FieldResult': ...
```

目标注册形式（伪代码）：

```python
PAGE_PLUGINS = {
    'b_and_r.injection_holding.multi_stage_position_time': PagePlugin(
        identity=BRInjectionHoldingIdentity,
        layout=BRInjectionHoldingLayout,
        extractor=BRInjectionHoldingFields,
    ),
    # 不同页面以独立 profile 注册；不在公共总调度里继续堆品牌 if/elif
}
```

**不要求一次性改成此接口**。先以适配器封装当前 Python 函数，保留旧提取的行为与测试；已迁移插件统一输出 `PageCandidate`、`LayoutResult`、`FieldResult` 的规范化信息即可。

## 6. 路由判定与兼容规则

- 一个注册插件确认，且没有与之互斥的充分证据：`matched + profile_id`。
- 仅有品牌/页面族证据、缺乏子页区分特征：`unknown + family_candidates`（或明确 `partial` 诊断），禁止伪造 `profile_id`。
- 两个或以上有效且互斥的页面候选同时成立：`ambiguous`，不调用其中任一字段提取器。
- 证据不足、只有数字/单位/通用标签：`unknown`。
- 尚未注册新结构插件的页面：`unsupported` 是**结构路由支持状态**，不等于整个 Reader 的最终失败；可进入旧兼容路径，并单独标记 `compatibility_path`。
- 旧 `template_anchors`、字段救援、绑定提示不得覆盖已经注册的新路由拒绝结果；已确认 `profile_id` 不因后续 OCR/字段失败改变。
- 图片文件名、数据集标签、品牌元数据仅是辅助信息，不能代替图片结构证据。

## 7. 布局重建：统一机制而非故障分支

**先建逻辑行列/段轴，再绑定观察到的证据**，不要以“检测到几张完整矩形”作为创建逻辑表的前提。

以 B&R 保压为例：

1. 从段号顺序和可靠的格子中心获取候选列轴，保持左右段位语义，缺号不自动压缩列序。
2. 从速度/压力/时间标签及水平排列得到候选行轴。
3. 形成逻辑交点 `(section, row_key, stage_id)`；每个交点可能只有预测位置，没有检测到实体边框。
4. 把 OCR bbox、真实边框/线条映射到交点；关联证据强弱独立记录。
5. 只有**唯一且可信的段位映射**才能进入自动字段输出；未验证值保留 `raw_reading`，标记 `needs_review`，不能错位导入。
6. 存在冲突时记录具体单元格、证据和原因，不把原始 OCR 整组抹掉。

推荐 `Cell` 概念（示意）：

```json
{
  "section": "holding",
  "row_key": "pressure",
  "stage_id": 1,
  "predicted_bbox": [100, 200, 160, 225],
  "observed_border_ids": [],
  "ocr_token_ids": ["ocr-45"],
  "raw_reading": "45.00",
  "stage_identity_verified": true,
  "mapping_status": "verified",
  "evidence": ["printed_stage_1", "column_alignment", "pressure_row"]
}
```

**必须区分**：`predicted_bbox` 只是逻辑候选；`observed_border_ids` 才是实测边框。缺一条边时不能凭预测框宣称检测到矩形。阈值（80% 面积、85% 边线覆盖等）只定义局部证据质量，不是整个表格或页面身份的最终真伪开关。避免继续按“漏一个格、漏一行、漏两行”分别加恢复函数。

## 8. 非矩形页面同样遵循契约

- **德马格**：布局模型可以是箭头段轴、复选框、逐段数值及独立实际值区，而不是三行矩形表。
- **阿博格 SELOGICA**：三角段号、v/p/s 或 v/p/t 行符号、独立实际值区；注意注射页的 `t` 不是每段时间行。
- **日精 TACT/TACT5**：`V...` 与 `Sv.../SM` 的错列关系，不可硬写“下行多一列”；精确子页需要额外证据。
- **伊之密**：中文段名、矩形段表、切保压模式块及不同区域联合区分。

这些特征仅来自已观察样本，插件不得宣布覆盖同品牌所有控制器/世代。

## 9. Agent 并行开发规约

**建议分工：**

- 一名架构/集成维护者独占公共契约与注册文件：`scripts/page_identity.py`、公共观察层、统一结果 schema、共享测试框架；其他 Agent 不得并发修改这些共享文件。
- 各页面 Implementor 独占各自 `*_page_identity.py`、`*_layout.py`、`*_extractor.py`、该页面 fixtures/回归；一个 profile 一份工作分支/worktree。
- 多 Agent 可并行研究 B&R、DEMAG、ARBURG、NISSEI、YIZUMI；各自仅提交自己边界内的文件。若发现需要公共 API 改动，提交接口提案，交由集成者统一变更。
- 共用插件契约/测试夹具命名在并行前冻结；每张票应独立自测，跨品牌冲突测试由集成者额外执行。
- 每页按以下交付：`profile_id`、支持样本范围、正/负/裁剪样本、具体证据、已知缺口、字段映射、安全拒绝实例、测试命令与提交 SHA。
- 不强制每票额外等待别的 Agent 验收才能自查；集成检查专门负责组合后的跨品牌回归。

## 10. 强制验收矩阵

| 场景 | 预期 |
|---|---|
| 原始完整页 | 正确 `profile_id`，字段不退化 |
| 只保留充分局部结构 | 仍确认页面 |
| 只有数字/单位/单个通用标签 | `unknown`，不得强行导入 |
| 同页面改变启用段数、灰显、工艺值 | 页面身份不变 |
| 只认出控制器族、不能区分子页 | 不强认 `profile_id` |
| 相似品牌/页面负样本 | 无错误模板确认 |
| 页面确认但一个字段 OCR 漏读 | 页面身份不变，只有相关字段待核 |
| 单格边框缺失/整行边框弱 | 基于联合证据恢复或安全待核，不发生段位错位 |
| 打印段号与 OCR/几何位置冲突 | 不自动赋段位，输出明确冲突 |
| 德马格工艺优化页误标为储料 | 不套储料模板 |
| OCR 漏读/误读（如 70.0 缺读、5.0→6.0） | 布局层不能凭工艺常识捏造正确数值 |
| 六品牌已有页面 | 无回归，明确冻结 OCR 与真实在线 OCR 的区别 |

验收证据应包含原图/裁剪、OCR 原值、视觉证据、路由候选及冲突、布局格/段号绑定图、字段状态和 JSON；真实拍摄的独立样本优先于从开发集裁剪或故障注入得到的派生样本。**测试通过次数不是未知照片准确率证明。**

## 11. 迁移路线（小步可验证）

- **M0：冻结规范和接口**（本文件）；不立即重写旧提取器。
- **M1：B&R 纵向切片**：用统一的逻辑网格结构替换 `_recover_holding_rows` / `_recover_missing_time_row` 等按漏检形态分叉的修补策略；以 `cdc3469` 为行为基线对比真实照片及安全拒绝样本。
- **M2：德马格页面插件**：注射、保压、预塑独立页面候选；非矩形布局验证公共契约是否抽象过度，工艺优化负样本必测。
- **M3：阿博格、日精扩展、伊之密分工作树并行**：页面插件按同一契约开发，集成者一次注册，做跨品牌混淆检查。
- **M4：可选品牌过滤**：待 `mold-data-webpage-tool` 机台主数据统一后，从 TrialCam 传机器品牌提示，只缩候选不代替视觉核验。

每个迁移步骤必须给出相对于基线的 **正确识别、错误确认、拒识、字段完整性及性能** 对比，禁止仅为了提高通过率放松安全门槛。

## 12. 当前实现与目标的差距（截至 `cdc3469`）

- 已有独立 `page_identity.py`；结构路由明确登记 B&R 和 TACT5，尚非所有页面。
- B&R 页面路由与提取已有一定解耦；`b_and_r_layout.py` 含两条缺格恢复分支，**尚未建立统一逻辑网格模型**。
- `visual_cells.py` 当前用 OpenCV 轮廓获取矩形，并施加面积/比例等候选筛选；检测结果不是所有可能单元格的全集。
- 保压 OCR 原值与最终验证字段已开始分别保存；但真实图像中 OCR 的 5.0→6.0 和 70.0 漏读是独立问题。
- 旧模板文字路由仍为未迁移页面提供兼容性；不得描述为“所有品牌已使用新结构路由”。

## 13. 给每位 Coding Agent 的简短执行指令

> 依据 `HMI_READER_PAGE_PLUGIN_ARCHITECTURE_V1.md` 开发你负责的 `profile_id`。只修改本页面身份插件、布局插件、字段提取插件与专属 fixtures/tests。公共视觉层只产证据，不含品牌语义。路由只决定页面身份，不读工艺数值。布局先建逻辑单元格/段轴，再用 OCR、边框、段号联合验证；保留未确认 raw readings，但不得自动输出错位字段。拒绝用固定段数、整屏绝对坐标、文件名或新阈值补丁来选页面。输出正例、负例、裁剪、冲突、OCR 失败和回归测试；公共接口改动提交给集成者处理。
