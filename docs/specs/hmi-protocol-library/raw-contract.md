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
