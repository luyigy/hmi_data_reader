# 公共原屏合同设计 v2

状态：hmi-protocol-library Spec 1.0 的规范要求，2026-10-18。这里定义待实施的兼容扩展，不表示运行接口已支持。Reader 是规范唯一编辑源，Model 通过接纳保留固定版本/哈希只读快照及完整页面原屏字段定义，人工入口不依赖 Reader 网络。

R01 实施范围：DEMAG 多级保压页现提供显式 `page_observations.v2`，JSON Schema 为 `contracts/page_observations.v2.schema.json`，完整字段定义为 `contracts/raw-pages/demag-holding-0.3.0.json`。冻结包位于 `templates/raw-packages/demag.injection_metering.multi_stage_holding/0.3.0.json`。本段仅声明 R01 的支持范围；R04 的温区与时间页面扩展见第 9 节。Model `raw_page.v2` 持久化不由 Reader 声明为已支持。

HTTP 在既有 `/api/v1/recognize` 增加 `observations_version=v2` 查询参数；不传时保留 v1。脚本 `extract_fields.py` 使用 `--observations-version v2 --original-image <实际原图>`，并校验矫正证据的原图哈希。包仍通过既有页面包 GET 和 `export_page_package.py <profile_id> 0.3.0` 导出。新包不改变活动 v1 模板。

本页定义覆盖 27 个数值或勾选显示字段，含实际值、逆序段表与深色残值。未实现的勾选读数显式 `unsupported`，页脚未核实含义/符号保留 `uncertain`，第三段压力的历史状态争议保留 `unknown`。因此当前观测 `coverage=partial`，不能宣称整页所有显示项均已可靠识读或允许业务自动写入。样本完整转录是开发者目视核对，明确不是独立验收真值。

`original_bbox` 使用原图百分比，`bbox` 使用矫正图像素；`transform` 保留尺寸、原屏四角与原图哈希。HTTP 上传原始字节的哈希与用于矫正的重编码图哈希分别记录为 `original_sha256` 和 `rectifier_input_sha256`。模板补单位只进入 `effective_unit` 及带定义哈希的 `template_ref`，不改写 `original_unit`。人工附图可用 `image_reference.sha256`，不冒充识图来源。

## 1. 结构与兼容

沿用 PageObservations 与 Model RawSnapshot/RawField。新增语义通过显式 v2 schema 承载，版本标识拟采用 page_observations.v2 与 raw_page.v2，具体 JSON Schema 与生成模型在 P1 固定。v1 解析仍保留，禁止原地改变 v1 enum 或把旧消费者不认识的第三态塞进布尔数组。

ScreenRecord 指完整原屏记录，不增加独立原屏数据库。Reader 生成观测，Model 保存带来源/修订的 RawSnapshot。ScreenInputSnapshot 是派生的解释入参。

## 2. 必需信息

| 对象 | 信息与约束 |
| --- | --- |
| 合同身份 | schema_version、页面字段定义版本/hash、page_identity、profile_id、页面/版式版本；未知页显式未知 |
| 记录身份 | Model 分配的 record/capture/group 标识、revision、内容 hash；Reader 不决定业务记录归属 |
| 页面定义 | brand、经核实的 controller_family/interface_generation、page_type/layout_variant、稳定字段键与物理含义；旧 ID 显式映射 |
| 字段身份 | screen_field_key 稳定且在定义内唯一；多段/温区以明确物理身份区分，不用 OCR 行号或 reader_n |
| 原始读数 | original_label、original_value、original_unit、原始文字；值保持数值/文字/布尔/空的实际类型，有限数值且尺寸受限 |
| 当前修订 | 当前 label/value/unit/role/state/物理身份；修订人、时间、理由和前后 revision；不覆盖原观测 |
| 段位 | section、稳定 segment_id、物理 stage 与展示顺序；支持反向段序，不靠列位置猜测 |
| 温区 | 稳定 zone_id、zone_source、展示 order、原屏名称；zone_source 区分 nozzle/barrel/hot_runner/mold_fixed/mold_moving/mold_slide/other |
| 观测证据 | 真实图片身份、原框或可还原到原图的坐标变换、坐标空间与原图尺寸、提取器/包/模型身份；缺证据明确标记 |
| 覆盖与问题 | 声明字段范围的 coverage 和有稳定 code 的 issues；不包含业务写入资格或工艺目标 |

新温区必须有协议定义的 zone_id。order 可变化，不构成 zone_id。同一温区身份重复、兼容物理分组内 order 冲突或字段归属矛盾须输出结构问题，不能覆盖。

## 3. 四维状态

| 维度 | 新链路值 | 解释 |
| --- | --- | --- |
| source | image_recognition / manual；历史 imported/monitoring 由 Model 兼容适配 | 输入渠道；不是角色 |
| role | setting / actual / unknown | 原屏值角色；actual 不自动映射 monitoring |
| state | enabled / disabled / unknown | 图像或明确人工证据所支持的启用状态 |
| reading | known / missing / uncertain / unsupported / conflict | 读数质量及协议可表达状态，与 role/state 独立 |

灰显残值允许 reading=known、state=disabled，数值、单位及框全部保留。低置信、浅色或没有读到不直接等于 disabled。unknown 不自动变 enabled；人工确认追加 revision 并保留 human 来源。Model 另算 projected/needs_review/excluded，不反写 Reader。

旧 stage_enabled=true/false 只按旧包确切语义适配 enabled/disabled，历史缺字段保持 unknown；v2 unknown 不能静默降成 false。不能无损降级的响应明确报版本不兼容或待复核。

## 4. 来源联合类型

识图来源包含 image_sha256、识读包 hash/版本、引擎/模型、观测证据。只允许真实图片哈希，入口校验图像归属。框若来自处理图，必须提供原图变换；没有框保留空和定位问题。

人工来源包含 actor、创建/修订时间及 revision，图像引用可选。无图不得要求或伪造 image_sha256、confidence、bbox。带图人工修订仍保留原识图来源，人工修订是追加记录。

模板补充单位或已审页面角色时，保留 raw_unit=null 等原始事实，另记 effective_unit/role 与 template_ref 来源。模板不能覆盖相反图像证据。Model 决定这些证据能否产生业务候选。

## 5. 纯观测示例

以下是信息结构示例，不是已上线 JSON Schema，也不预定现有字段的机械重命名。

```json
{
  "schema_version": "page_observations.v2",
  "profile_id": "verified-controller.temperature.layout-a",
  "source": "image_recognition",
  "fields": [{
    "screen_field_key": "barrel-zone-a.setting",
    "original_label": "料筒一区",
    "original_value": 200,
    "original_unit": "°C",
    "role": "setting",
    "state": "unknown",
    "reading": "known",
    "zone_id": "barrel-a",
    "zone_source": "barrel",
    "order": 1
  }]
}
```

完整响应仍需图像、包、页面定义身份和证据。示例不含 web_target、工艺路径、机器百分比基准或 ProcessData。人工记录具有同等业务事实时，来源字段和证据自然不同。

## 6. 覆盖和错误

coverage.status 为 complete/partial/not_observed/unsupported，按声明范围给出缺项。unsupported 必须有 reason，区分协议未实现与不适用；不在 Reader 判断业务是否应该采集。

页面未知、包停用、页面冲突、版本不兼容分别输出稳定 code。停用和冲突不得借未知页 fallback 绕过。Model 的业务不采集/未接纳另有 Model 原因 code。

## 7. 合同变更与验证

Reader 修改规范、schema、页面定义及样例，生成版本/hash；Model 更新接纳快照和双端兼容测试。新字段验证、人工来源校验、旧响应适配、温区唯一性和状态穷尽测试同时交付。

冻结旧合同哈希，历史记录按原版本回放。不得修改已发布版本文件内容。废弃版本仍可回放但可禁止用于新采集。工艺解释和正式业务 schema 始终由 Model 管理。

## 8. R02 控制器绑定输入与兼容回执

HTTP `POST /api/v1/recognize` 接受可选查询参数 `controller_hint`，值为 JSON 字符串。脚本 `extract_fields.py --controller-hint <JSON文件>` 使用相同结构。旧调用方不传提示时继续原路由。绑定由调用方按获批机台修订传入，Reader 不创建机台绑定，也不从品牌猜控制器。

```json
{
  "brand": "BOLE",
  "controller_family": "B_AND_R",
  "interface_generation": null,
  "binding_revision": 1,
  "pages": [
    {
      "profile_id": "b_and_r.injection_metering.real_photo",
      "version": "1.0.0",
      "package_sha256": "由页面包 GET 响应计算的 SHA-256"
    }
  ]
}
```

示例 profile 是行为验证在隔离目录发布的页面，不代表生产目录已发布。`pages` 是列表，以完整 `profile_id` 区分页型和版式，同页型可有多项；一个绑定中同一 profile 只允许一个版本。包哈希采用 UTF-8、`ensure_ascii=False`、排序键、紧凑分隔符、禁止非有限数值的完整包 JSON。绑定须固定版本和包哈希，不能只引用活动指针。

新草稿可携带 `page_identity`，冻结在模板及包中，目录 GET 同时返回它。身份包含 `brand`、`controller_family`、`interface_generation`、`page_type`、`layout_variant` 和非空 `evidence_sample_ids`。页型/版式须与模板一致，证据样本必须在本包中。经管理员核对的控制器身份使用原样字符串；代际没有依据时为 null，只与 null 提示匹配，不代表已验证任何代际。审核仍由已有管理员发布权限约束，样本引用校验不替代语义审核。历史包不补写元数据，不自动变成已核实控制器包。

带提示时，Reader 只从绑定冻结包中选页，必须命中 OCR 页锚点。图像分类和模板指纹分别保留，任一相反证据都不能被提示或另一分类结果覆盖。多个候选或绑定外相反页证据拒绝成功。即使冻结包可回放，当前页面停用也禁止新识读；读取旧包和离线回放仍保留。活动版本升级不改变旧绑定，回滚通过已有新版本发布流程复制旧配置，版本历史追加保留。

识读响应的 `compatibility` 独立于字段识读 `status`。`compatible` 只表示页面/包匹配，不表示字段齐全或 Model 可写入。成功回执包含选择依据、图像家族证据、绑定修订、profile、固定包版本/哈希、页面身份和 profile 生命周期状态。Reader 不输出 Model 业务接纳资格。

| compatibility.status | code | 行为 |
| --- | --- | --- |
| compatible | PAGE_COMPATIBLE | 使用 OCR 与固定包选定页面，保留实际字段识读结果 |
| unknown | PAGE_UNKNOWN / CONTROLLER_UNKNOWN | 未找到已绑定页或注册控制器；带提示时不输出通用字段 |
| disabled | PAGE_TEMPLATE_DISABLED | 页面停用，新识读拒绝；旧包 GET 保留 |
| conflict | PAGE_BINDING_MISMATCH / PAGE_TEMPLATE_CONFLICT | 控制器/代际错绑、相反图像证据或多个页候选，拒绝输出字段 |
| incompatible | PAGE_PACKAGE_INCOMPATIBLE | 包版本不存在、包结构不支持或哈希不符，拒绝输出字段 |
| incompatible | CONTROLLER_METADATA_UNVERIFIED | 冻结模板无经核实身份，禁止提示强制选页 |
| incompatible | EXTRACTOR_VERSION_INCOMPATIBLE / EXTRACTOR_PAGE_INCOMPATIBLE / EXTRACTOR_CONTRACT_INCOMPATIBLE | 既有提取器/合同检查拒绝，不进入通用提取 |
| incompatible | CONTROLLER_HINT_INVALID | HTTP 输入返回 422；CLI 无效 JSON 文件返回参数错误 |

停用、冲突、不兼容在任何分辨率救援或重提取中都保留提示并拒绝 generic fallback。带提示的未知页也拒绝通用提取。无提示未知页保留旧通用提取行为，同时报告 `compatibility.status=unknown`。`observations_version=v2` 的兼容拒绝继续返回 HTTP 422 并保留相同原因 code。R02 本身不增加原屏 v2 页面；R01 与 R04 的明确页面支持范围分别见前文与第 9 节。

行为入口为 `tests/test_hmi_protocol_library_r02.py`，用已有原图、实时 CPU OCR、真实 HTTP multipart、CLI 子进程、受控发布和包 GET/新客户端读回分别验证。所有新发布仅在受管输出的隔离目录。样本已用于开发，不作独立留出集。Model 机台持久化、浏览器和业务保存重开由相应 Model 票及平台独立验收负责。

## 9. R04 温区与相关时间扩展

R04 扩展原屏观测字段，不更改第 8 节的控制器绑定与兼容拒绝规则。新增冻结原屏包不自动成为已核实控制器绑定页，也不改变绑定引用的页面包版本或哈希。带提示的停用、冲突、不兼容或未知页仍按第 8 节拒绝，不能借温区与时间适配器绕过。下文储料页的 generic 适配限定在无提示的既有路由结果，不授权带提示时通用提取。

`0.4.0` 是独立冻结的 OCR 识读包，合同仍标识 `page_observations.v2`，包内嵌 `contracts/page_observations.temperature-time.v2.schema.json`。保留 R01 的合同和 `0.3.0` 包字节及实现哈希。

当前声明两个页面的有限字段范围。

- `demag.temperature.screen_order_5` 按可见列头识别喷嘴1、区1至区8、料口的设定/实际值。`barrel-3` 等身份来自物理区号，`order` 按当次显示顺序记录。料口为 `feed-throat / other`，不冒充料筒或模具温区。未出现的列不会补零。冷启动保护与延时手动降低另有独立字段键。冒号显示保留文本，角色未核实保持 unknown，不转成秒。
- `est.storage_cooling.cooling_delay` 从储料页分别读出储前冷却与模具冷却设定。严格匹配三个可见标签后使用此受控适配器，v1 的 generic 响应保留。它们不合并为一个 cooling_time，也不包含 Model 的业务目标。

HTTP 继续使用 `/api/v1/recognize?observations_version=v2`，新观测的权威页面身份位于 `page_observations.profile_id`。顶层字段及 profile 保留原 v1 结果。脚本继续使用 `extract_fields.py --observations-version v2 --original-image <原图>`。新增版本须显式通过 `/api/v1/page-templates/<profile_id>/package?version=0.4.0` 或 `export_page_package.py <profile_id> 0.4.0` 获取，不改变活动 v1 模板。

离线校验使用 `raw_temperature_time.validate_temperature_time_record`。同一 zone 的 setting/actual 可以并存；重复同角色身份、同物理分组 order 冲突和字段定义归属矛盾会拒绝。识读时重复列头保留候选并输出结构问题。单位冲突保留原单位，模板仅补 effective_unit。温度页没有已标定的启用状态解码器，state 均为 unknown；颜色和缺读不会推成 disabled。

包内样本是开发验证材料。既有温度真值的模型与待人工确认来源原样保留，新增时间转录标为实施者目视核对，不是独立验收。Reader 的包 GET 和离线读回不等于 Model 草稿保存重开、温度换算、正式业务提交或双视口验收。具体本轮检查和缺口记录在任务受管结果区。

R04 同版式修复使用独立版本 `0.4.1`，保留 `0.4.0` 定义和包字节。旧识读模块的精确副本位于 `templates/raw-recognizers/temperature_time_ocr.v2/0.4.0/scripts/raw_temperature_time.py`，旧包校验使用该副本的哈希。HTTP 包 GET 和脚本导出继续支持旧版本，新识读观测标记 `0.4.1`。R01 `0.3.0` 包保持不变。

`0.4.1` 增加仓内同版式原图 `barrel_A02_b24ff33d.jpg` 作为开发回归样本。定义记录该图 OCR 将喷嘴1读为“喷剪1”的别名，观测仍保留原始 `zone_label`。时间字段以 `value_format` 区分数字设定值和冒号文本，避免把 `0` 与 `0:00` 当作同一字段的冲突候选。匹配区域容纳两张照片的矫正差异，`recovery_region` 保留小零值的窄框放大重读。低置信度数值仍标 `uncertain`，没有读到的值保持空，不补默认值。
## R05 伯乐三段熔胶原屏包

本仓新增 `b_and_r.metering.three_stage`，当前发布版本为 `1.0.1`，受控提取器为
`b_and_r.metering`。使用已有矫正、CPU OCR、页面草稿和发布流程，不接入 VLM。
字段定义位于 `contracts/raw-pages/b-and-r-metering-1.0.0.json`；冻结包通过现有页面包
GET 和 `export_page_package.py` 导出。`1.0.0` 保留，`1.0.1` 补充既有模板指纹配置，
使普通上传可选中该页。旧包和旧识读器未改写。

这次新增的是有三段熔胶、前后抽胶、模式、阀和计时器区域的结构版式。
不能仅凭显示列数推断控制器或启用段数。控制器证据来自用户原图中的伯乐、贝加莱和
EKS 标识，以及来源原图的相同结构；界面代际没有充分依据，保留 null。
此前白色储料页草稿保留为开发记录，不作为必须补图的条件，也没有发布。

完整声明范围为 38 项工艺显示字段，包括页首实际值、熔胶实际值、三段设定、
前后抽胶、三个枚举控制项和五个时间读数。时钟、配方名、导航及未解码指示图标保留在
原图引用和 OCR 证据中，不宣称已识读其状态。速度百分比不换算为转速；各时间参数不
合并成冷却时间。所有启用状态保持 unknown。字段缺值、低置信、单位矛盾和同一传感器
重复显示不一致分别保留问题，不用真值替换 OCR 原值。因此输出为 review、coverage.partial，
不代表 Model 已接纳或可自动写入业务。

开发图、用户补充验证图和另行保留的验收图位于 `datasets/r05/b_and_r.metering.three_stage/`，
分别记录原图哈希、来源、用途及转录。用户图在发现页首 OCR 漏字后进入诊断回归，不再声称
是未参与开发的盲测图。另行保留的验收图为独立拍摄，同开发图来自相同机台和配方，具有
不同实际读数；不宣称机台隔离或统计意义上的盲测。真值为实施者目视转录，平台独立复核另行执行。

新包携带字段定义、公共 schema、OCR 样本、受控识读器源码及哈希。导入者可离线读取
字段定义，识读端拒绝来源代码哈希不符的包。历史记录按固定版本读取；停用通过新版本
发布禁止新采集，回滚通过追加版本恢复旧配置，不改历史版本。

## R6_DEMAG 机器配置总览页

新增 `demag.injection_metering.machine_configuration / 1.0.0`，受控提取器为
`demag.configuration`。这是本票唯一新增物理版式。同屏包含射出、保压、预塑、切换条件、
冷却时间和五个温区。复用原有矫正、CPU OCR、注册、草稿试跑、冻结发布与包 GET。
没有增加业务解释或工艺换算。

控制器身份只声明已有人核验的 `DEMAG` 家族。核验来源及哈希保存在字段定义中，
原图还保留 Sumitomo SHI DEMAG 面板标志。具体 NC 型号和界面代际没有直接依据，保持 null。
旧射出、保压、塑化和温度包的身份、版本及源码保持原样，不据此补写为已核实控制器包。

定义位于 `contracts/raw-pages/demag-configuration-1.0.0.json`，声明 29 个数值字段和
6 个未解码的控制图标。工艺相关读数有各自稳定键，冷却、保压时间和切换实际时间分别保留。
预塑速度保留屏幕的 mm/s，不因历史字段名含 rpm 而换算。模具、顶针、射座设定、生产计数、
循环监控、导航及其他指示图标不在新增声明范围，仍保留原图和完整 OCR 证据。

区域查找先用三个唯一 OCR 标签对齐。温区身份来自列头，展示顺序来自已核实的物理列位置，
漏识列头不会将后列压缩编号。重复列头保留结构问题。所有启用状态均为 unknown，
深色残值不会自动变为 disabled。6 个控制图标输出 unsupported，不从相邻数字推断勾选状态。
压力缺失可见小数位时保留 OCR 原值并标 uncertain，不补小数点。单位与模板矛盾时保留原单位，
不能将 bar_spez 或 OCR 的 `bar spez` 当作普通 bar。缺读保持空，不用转录真值回填。

原图、来源回执、转录和用途位于 `datasets/r6_demag/`。development 为开发图；
reserved、acceptance 在暴露坐标和温区问题后转为诊断回归图，其文件名不代表仍是独立留出图。
holdout 为冻结后实际运行的裁切及特殊压力单位挑战图，首轮结果另存受管证据。
该图也暴露了单位 token 边界问题，来源记录如实保留这次诊断参与，不能宣传为未见过的盲测正例。
转录均为实施者目视记录，独立平台复核另行执行。

响应为 review、coverage.partial。普通 bar 开发图和特殊压力单位挑战图的实际覆盖分别登记，
不声明所有裁切照片或压力单位变体均能完整识读。确切控制器代际、图标解码、完整页面字段、
新的独立正例泛化及 Model 接纳、业务保存重开和正式提交仍需各自证据。
指定行为入口为 `tests/test_hmi_protocol_library_r6_demag.py`；Reader 包 GET 和新进程导出
不是 Model 浏览器保存重开的证据。

## R6_BOLE 既有射胶/保压页的原屏扩展

本票仅覆盖已核实的 BOLE / B_AND_R，界面代际为 null。复用既有物理页
`b_and_r.injection_holding.multi_stage_position_time`，新增其 `0.6.0` 原屏包，
没有新增控制器或物理版式。温度、三段熔胶的既有能力分别回归，不扩展其他伯乐控制器。

原屏定义在 `contracts/raw-pages/b-and-r-injection-0.6.0.json`。冻结包位于
`templates/raw-packages/b_and_r.injection_holding.multi_stage_position_time/0.6.0.json`，
通过既有页面包 GET 和导出脚本显式指定版本取得。识图仍使用既有矫正、PaddleOCR、
注册的 `b_and_r.injection_metering` 与 v2 观测分发入口。没有增加任意 import、
VLM 或工艺解释器。包中继承的 v1 模板迁移候选不授权 Model 自动写入。

共声明 47 个字段。射胶五个物理槽位的速度、压力、位置和实际时间，保压五槽位的
速度、压力和设定时间，以及实际值、切换设定、实际切换值分别保留。槽位没有数值时
输出 missing，不从有效段数补值。反向显示顺序与 stage/segment_id 分离；列头没有读到时
使用经原图核对的固定槽位定义，标明 identity_basis，并将读到的数值标 uncertain。
重复列头产生结构冲突。实际时间不冒充设定时间，也不合并成 cooling_time。

所有自动启用状态保持 unknown，保留灰显零值、真实 OCR 框和置信度。位置、时间、
外部信号的勾选解码均为 unsupported。页首状态条、曲线及导航不在本包声明范围。
因此 coverage 为 partial；本包不承诺整页自动写入。

两张原图来自既有 `ground_truth/bole_BR`，原图哈希、用途与转录位于包内定义及
`datasets/r6_bole/`。转录是实施者目视核对，两图均历史曝光，并用于本轮 OCR 诊断；
第二张只作为保留回归图，不宣称调参独立或盲测，不作为新布局泛化证据。
平台独立验收须另行检查这些限制，不能把实施者 pytest 当作独立验收。

既有 v1 射胶模板以 `0.1.2` 追加 OCR 标签别名“保压奶换”。`0.1.1` 的模板和完整包
先行归档，`0.1.0`、R05 熔胶包及 R01/R04 原屏包保留。v1 输出仍走旧提取器；
新原屏扩展需要 `observations_version=v2`。带绑定提示时继续执行已有错绑、未知、停用、
冲突和合同不兼容检查，不通过通用提取绕过拒绝。

本票不提供 B&R 温度的 v2 zone 观测、冷却设定闭环、Model 接纳、草稿保存或正式 Run 提交。
API 上传与 CLI 实时 OCR、包 GET/独立客户端重开、旧版本回放分别记录在本票受管证据中。
没有变更 UI，双视口浏览器操作不适用；Model 业务保存重开仍由对应 Model 票负责。
