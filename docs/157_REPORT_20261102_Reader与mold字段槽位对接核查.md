---
doc_type: REPORT
doc_status: completed
next_action: none
---

# Reader 页面结果与 mold 标准槽位对接核查

本次只修改 Reader 的结果模块命名；mold 只读检查基线为 15312051300773e21d86f15812e5dd34b5dc0d49，工作区干净。下列是当前源代码关系，不是已经实现自动接纳或业务写入的声明。

## 一个字段经过三层身份

Reader 的 `page_result.py` 组装原屏结果，公共分发仍为 `scripts/raw_observations.py`。只改模块名，`page_observations.v2` 协议、响应键和函数名保留。

```text
原屏字段 screen_field_key
  → mold 接纳规则 raw_policy.bindings
  → mold 稳定输入 field_id
  → 已审物理语义 + replay_protocol
  → 品牌无关的标准参数
```

下表 n 是物理段号；i/h 是标准段的 segment_id，实际保存的 segments 是数组，不能把数组下标与段号混淆。

| Reader 原屏键 | mold 稳定输入字段 | 标准参数路径/语义 |
| --- | --- | --- |
| injection.speed.stage-n | injection.speed.n | injection.segments.i<n>.speed |
| injection.pressure.stage-n | injection.pressure.n | 本页为 injection.segments.i<n>.pressure_setpoint，不能误写 pressure_limit |
| injection.end_position.stage-n | injection.end.n | 非末段为 injection.segments.i<n>.end_position；本页末段保留 panel_end_position，有效终点由 V/P 位置决定 |
| holding.speed.stage-n | holding.speed.n | holding.segments.h<n>.speed，页面事实解释为保压限速 |
| holding.pressure.stage-n | holding.pressure.n | holding.segments.h<n>.pressure，并保留 pressure_trajectory |
| holding.time.stage-n | holding.time.n | holding.segments.h<n>.time，本页为段持续时间；screen_time_fact 保留原屏含义 |
| switch.setting.position | vp.position | injection.vp_switch.position，且参与本页末段有效终点 |
| switch.setting.time | vp.switch.time | injection.vp_switch.time |

依据为 mold 的 backend/app/hmi_mapping/accepted_packages/b_and_r.injection_holding.multi_stage_position_time.lock.json 的 0.6.0 raw_policy；page_profiles.py 的 _semantics；protocol.py 的 replay_protocol。它是已有接纳版本的映射事实，本次核查没有授予 0.6.3 相同接纳资格。

47 个声明字段中，32 个有业务绑定，12 个实际值只保留观测，3 个切换选择框作为控制证据。32+12+3 完整覆盖且不重复。实际值不能因为看起来有数字就写入设定值；选择框决定模式，也不是普通数字槽位。

## 标准字段是否要改

mold 当前 PROCESS_SCHEMA_VERSION 为 3.2。parameter_run_holding.py 中 V3HoldingSegmentDraft 已有 speed，S03HoldingDraft 沿用它；protocol.py 的 HoldingBinding.speed_limit 会生成 holding.segments 的 speed。同时已有 speed_mode=per_segment/global_limit、global_speed_limit、speed_purpose=holding_limit。因此“各段保压速度在主仓无槽位”已经不能用来描述当前标准模型。

DEMAG 旧 profiles/demag.injection_metering.multi_stage_holding.yaml 仍使用 holding.speed.uncollected.{n}，screen_projection.py 的旧默认绑定也只有压力/时间，并会把 holding.velocity.* 标为 business_not_collected。这个页面要修的是已审字段语义、冻结绑定及其验收链路；不能只把 Reader 字段改名就认为自动支持，更不应先为同一含义新增品牌专用标准字段。

当前已有槽位足以表达 B&R 射胶/保压上述字段，无需仅为本次改名修改标准模型或数据库。正式冻结跨品牌标准合同仍需 mold 专项确认，包含版本、单位、压力侧别、速度用途、时间定义、段序和兼容策略；本片不冒充已完成该冻结。

## 无缝对接必须同时满足

1. 页面、版本和来源一致：profile_id、图片哈希、包版本、合同/字段定义/识读器哈希均与 mold 接纳版本一致。mold page_packages 保存包内容，accepted_packages 保存接纳锁、绑定和策略；二者不是两个可独立编辑的页面规则源。
2. 身份绑定明确：每个原屏键只有一个处置，映射或保留；本页现有绑定要求目标唯一。设定角色、区段和物理段号必须匹配，不依赖中文标签模糊猜测。跨品牌同一物理含义归同一标准槽位；一个实际值不能冒充设定值。
3. 物理语义一致：% 与 mm/s 保留原值和单位，换算依赖冻结的 100% 速度；液压/塑料压力侧别和增压比明确。保压持续时间与累计切换时刻、段起点与终点、压力设定与上限、段限速与全局限速必须显式区分。换算缺依据应报告缺失，不能填猜测值。
4. 质量与启用证据足够：screen_projection.py 对 v2 要求 setting 角色、enabled 状态、known 读数、数值/单位有效且无冲突；切换位置/时间还检查三个布尔控制证据。原图框与坐标变换是原图复核必须具备的证据，但当前投影门槛未把缺框全面编码为拒绝，不能把现有代码放行等同于满足用户期望。
5. 候选与保存分开验收：project_screen 产生候选，不授予保存权限；image_recognition 直接输入在部分 route_and_replay 规则中仍要求确认，而已保存原屏经 project_screen 会转换为带证据的 imported 输入。这两条路径须分别验收。自动生成正确候选不等于无确认业务写入；保存后 API 读回及退出重开仍需实际验收。

## 当前缺口与验证边界

mold B&R 文件默认 current 是 0.1.1，锁仅登记 0.1.1、0.1.2、0.6.0；数据库运行时指针未查询，不能推断线上实际生效版本。Reader 当前改名包为 0.6.3，尚未接纳，不能直接升级替换旧响应。

Reader v2 仍未完成启用态和切换框识读，不能靠改名解除这些门槛。两份冻结回放各 47 字段，development/retained 分别 19/6 个 known、0/0 个 enabled。本次冻结输入未提供坐标变换，所以原图框都是 null；这不能推断完整在线管线也都缺框，但也不能算完成了原图 bbox 验收。

本次运行：Reader 完整测试 294 passed、12 skipped、22 subtests passed；新旧两个样本结果除版本/哈希元数据外完全一致；0.6.0/0.6.1/0.6.2 冻结包逐字节保持；47 字段静态绑定覆盖、唯一性、角色和段位检查通过。统计及完整结果位于 output/page-result-20261102/。没有导入 mold app.db、访问业务数据库、运行 mold 集成测试或做真实保存；没有部署或独立人工验收。

建议下一片在 mold 冻结品牌无关字段合同和按页验收入口，先复用现有标准槽位，补齐 DEMAG 等页面的明确绑定；同时在 Reader 单独补启用态、控制框、原图定位证据。用户确认范围后再实施，不因本报告自动开工。
