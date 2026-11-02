---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: docs/156_PLAN_20261102_页面结果命名与mold槽位核查.md
slice: S01
plan_progress: complete
---

# Reader 结构定稿与 mold 整理接续

## 当前停在哪里

用户正在另一个 Session 同步整理 mold 仓，要求先把两边文件结构理清楚，之后再继续字段合同和对接。本次仅保存交接，不继续改 Reader 算法、不跨仓重构、不接纳新包、不部署或写业务数据。156 PLAN 的 S01 已完成；后续实施不是该计划的自动下一片，需根据用户届时指定的范围安排。

本节点 Reader 路径为 /data1/code/hmi_data_reader，分支 deploy/yizumi-auto-page，代码基线为 90856bbf3dd27aa30d523dabc2ab355f6dc56564。创建本文前工作区干净。

mold 本节点已知路径为 /data1/code/mold-data-webpage-tool。此前只读核查基线为 15312051300773e21d86f15812e5dd34b5dc0d49；用户现正另行修改，不能把该基线或旧路径当作整理后的最新事实。恢复时先检查 mold 当前规则、状态和交接；不覆盖并行 Session 的未提交改动。

## 用户的长期目标

- 代码按具体 HMI 页面自包含组织，每次新增页面都能从目录和文件名直观看出增加了什么，不靠散落补丁。
- 路由先利用可信的品牌/控制器线索缩小候选，再凭页面结构证据确认具体页面。
- 布局重建是稳定提取的核心，必须能解释数字归属于哪一行、哪一物理段及哪个字段。
- 后续尽量固定 mold 的品牌无关标准字段及通用消费入口；新品牌和新页面主要修改 Reader 实现和页面配置。
- 用真实图片、字段值/单位/状态/原图 bbox、映射覆盖及保存读回证明结果，减少反复手动进入“HMI现场采集”上传和选槽位。

用户当前先推进文件结构整理，不代表上述全部功能已实现或已授权在本片实施。

## Reader 已实现的页面结构

```text
scripts/extract_families/b_and_r/injection_holding/
├── README.md
├── page_identity.py
├── layout.py
├── extractor.py
├── page_result.py
├── package.py
├── verify_stability.py
└── __init__.py
```

完整 profile_id 仍为 b_and_r.injection_holding.multi_stage_position_time。它是稳定身份，不机械展开成三级源码目录。已删除多余 multi_stage_position_time/ 目录；holding_layout.py 合入 layout.py；headers.py 合入页面身份模块；observations.py 改为 page_result.py。

| 层/文件 | 当前职责与理解边界 |
| --- | --- |
| 公共图像/OCR/视觉层 | 图片纠正、OCR 和通用边框等视觉能力；不堆入某页面业务 |
| 公共路由 + page_identity.py | 页面插件判断“是否符合本页”，公共路由组织候选、选择或拒绝；品牌提示不能代替页面证据。目前只保留 B&R 射胶保压页实现，不声称已支持温度页 |
| layout.py | 用区段标题、标签、文字坐标、印刷段号及实体边框等证据建立区段、行列、逻辑格和物理段位，再绑定 OCR。不是重新画表单，也不是仅将 OCR 按坐标排序 |
| extractor.py | 从已归属字段的位置读取和解析值、单位、置信度及状态，检查冲突；不决定覆盖 mold 哪条记录 |
| page_result.py | 组装原屏结构化结果，保留字段身份、原值、单位、角色、段号、状态、框、来源和问题；不是最终工艺参数或自动写入许可 |
| package.py | 冻结字段定义、源码清单及哈希，管理发布版本；不读图 |
| verify_stability.py | 回放历史照片的冻结 OCR，检查数值与状态是否退化；不重新运行 OCR，不证明未知图片准确率 |

阅读入口为 scripts/extract_families/b_and_r/injection_holding/README.md，架构入口为 docs/architecture/001_HMI_READER_PAGE_PLUGIN_ARCHITECTURE_V1.md。scripts/README.md 说明公共入口及工具类别；各代码目录已配 README。

### layout 的关键解释

它需要把“75.0 + OCR 矩形框”变成“该框属于保压第二段的速度格”。源码内已有中文坐标词典和分步讲解：射胶物理三行、段号核验、保压逻辑网格、证据绑定和冲突检查。

预测格位置不等于检测到真实框；空间绑定 verified 不等于 OCR 数字读对；读数 known 不等于该段 enabled；这些都不等于 mold 接纳保存。

当前 v1 使用物理三行与保压逻辑网格，v2 仍保留历史冻结区域规则。职责已经归位，但两套算法没有统一。新增页面应优先用一套布局结果适配输出合同，不机械照抄历史双路径，也不为未来布局预建空目录。

## 输出与版本边界

页面结果模块叫 page_result.py，已有函数名及 page_observations.v2 等 JSON 协议名保留，不因改文件名改跨仓 API。v2 公共分发入口仍为 scripts/raw_observations.py；实际服务调用及 v1/v2 入口恢复时按当前代码核对。

当前源码包为 0.6.3：
- contracts/raw-pages/b-and-r-injection-0.6.3.json
- templates/raw-packages/b_and_r.injection_holding.multi_stage_position_time/0.6.3.json

0.6.0、0.6.1、0.6.2 冻结包逐字节保留供历史导出；旧 v2 绑定拒绝静默用新源码冒充旧身份。后续修改包清单内源码时必须发布新源码版本，不原地覆盖已提交冻结包。

## mold 对接：事实与建议分开

真实核查详见 docs/157_REPORT_20261102_Reader与mold字段槽位对接核查.md。

此前确认的示例：Reader holding.speed.stage-2 → mold 稳定输入 holding.speed.2 → 最终 holding.segments.h2.speed。h2 是 segment_id，segments 实际是数组，不是数组下标。B&R 47 个字段中 32 个绑定业务、12 个实际值保留观测、3 个切换选择框保留控制证据。

mold 标准模型 3.2 已有逐段保压速度。DEMAG 旧配置却仍标为不采集，需区分页面绑定未接通与标准模型缺槽位，不能直接新增品牌专用字段。压力设定与上限、液压与塑料压力、时间定义、速度用途、段终点与 V/P 条件都要明确。

此前 mold 文件锁仅登记 B&R 0.1.1、0.1.2、0.6.0，文件默认 current=0.1.1。当前 Reader 0.6.3 尚未由本 Session 推进接纳；用户并行修改后的状态须重新核对。未查询数据库运行时指针，不能推断线上版本。

已讨论的目标方向是：mold 发布唯一、版本化、品牌无关的标准字段合同；Reader 声明页面字段对应的标准物理身份和段序；mold 通用适配器固定转换到内部参数结构。Reader 不直接依赖数据库列或内部数组路径。后续新增页面若复用既有标准字段，应经通用导入、校验和接纳完成，尽量不改 mold 业务代码。

这仍是待核查/确认的设计方向，未冻结或实现。此前交流中的 standard_field、segment_order 等 JSON 示例仅为建议，不是当前 API。自动生成正确候选、页面版本接纳与业务保存授权也是不同事项，不能混为“自动通过”。

## 已有验证与未完成项

代码基线 90856bb 的实测记录：294 passed、12 skipped、22 subtests passed，3 条既有弃用警告；两份各 47 字段的 v2 冻结回放除版本/源码身份外保持一致；三份旧包逐字节未变。输出在 output/page-result-20261102/，该目录是本地证据，不保证新克隆自带。此前 v1 七张照片 131 个读数/状态保持一致，详见 155 HANDOVER。

Reader v2 启用态仍为 unknown，切换勾选识别未闭环。两份冻结样本没有坐标变换，因此 original_bbox 为 null；不能据此断言在线全流程也都没有原图框，也不能将此回放当作原图框验收。

尚未完成：跨仓标准合同冻结、新包正式接纳、无人工逐字段选择的完整流程、在线 OCR 新照片验收、mold 保存/API 读回/退出重开验收、独立人工或另一 Agent 验收。本次仅新增文档，不重复运行代码测试。

## 接续顺序与停止条件

1. 先读取本仓规则、本文、157 REPORT 和最新 git status/log，确认 Reader 没有发生后续变化。
2. 读取用户在 mold 结构整理 Session 的最新交接、提交和当前目录，按真实调用链更新对接认识。旧报告路径只作导航线索，不机械恢复旧文件结构。
3. 汇报两仓文件职责和可消费结果边界，保留 extractor 这一层，避免再次把 layout 直接描述成最终结果生成器。
4. 根据用户指定的下一片，决定是冻结 mold 标准合同、统一接纳入口，还是补 Reader 布局/启用态/框证据。三者不要未经确认捆成一次大重构。
5. 未获下一片明确范围时停在同步结果，不扩品牌、不修算法、不部署、不写业务数据库。只查看文件组织不足以宣称无缝对接。

历史回滚点：backup/reader-before-page-cleanup-20261102（1308f26）、backup/reader-before-tools-cleanup-20261102（3c90b42）；后续整理提交为 6dee04d、31ea239、90856bb。撤销需按实际目标选择独立 revert，不重写历史、不覆盖并行改动。

<!-- WORKFLOW_PROMPT_START -->
阅读 AGENTS.md、docs/159_HANDOVER_20261102_Reader结构定稿与mold整理接续.md、docs/157_REPORT_20261102_Reader与mold字段槽位对接核查.md 和 B&R 页面 README，检查 git status/log。Reader 当前结果模块为 page_result.py，已知源码包 0.6.3。用户正在另一个 Session 先整理 mold 文件结构；先核对那边最新交接和实际代码，不把旧路径、接纳版本或建议 JSON 当成当前事实。汇报两仓结构与对接缺口，等待用户指定下一片，不自动扩页面、改算法、部署或业务写入。
<!-- WORKFLOW_PROMPT_END -->
