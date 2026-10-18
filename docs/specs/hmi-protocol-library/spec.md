# 原屏采集协议库 Reader 实施 Spec

版本：1.0，2026-10-18。范围：图片到原屏物理观测，及原屏合同、页面定义、受控适配器发布。tickets 已发布，见 tickets.md；尚未批准路线或实施。

## 1. 目标与边界

照片经过已有矫正、OCR/VLM 和页面适配后，输出与人读原屏一致的标签、原值、原单位、设定/实际角色、段位/温区、启用状态和证据。Model 再负责原屏到统一工艺数据，Reader 不定义 web_target、工艺目的地或机器换算。

与本文件配套：raw-contract.md 是公共原屏规范；总体产品、Model 实施、路线和验收在 mold-data-webpage-tool 的 docs/specs/hmi-protocol-library/。不复活已撤回 contracts/process-screen/v1-draft 的 Reader 工艺转换设计。

## 2. 复用基线

当前检出为 47ad710723ad4d123c84dbfad5482407587845ed，R02 固定交付为 982ef2d021286ffff4e2e352af68b2efd6f0bf77，二者分叉且当前原仓有未提交服务/模板改动。

P1 前在获批工作区核对、集成 R02 注册/生命周期增量并记录新 SHA，保留原仓未提交内容。不自动 reset、stash 或重建整仓。源码已保存不代表已部署或已验收。

继续使用 hmi_service.py、scripts/extract_fields.py、scripts/extract_families/、page_template_registry.py，以及 R02 extractor_registry.py、extractor_capabilities.py、page_template_drafts.py、page_template_lifecycle.py、page_template_store.py、export_page_package.py。

已有 contracts/profiles.json 与 field_catalog.json 按版本迁移，旧 web_target 仅供旧包迁移读取，新公共合同剥离业务目标。长调度文件不得继续堆品牌分支；新职责提取短模块，保持旧调用兼容。

## 3. 交付要求

1. 扩展现有 PageObservations，实现 raw-contract.md 的稳定字段键、四维状态、原图坐标、来源和版本。Reader 只输出识图来源；人工合同的联合类型用于 Model 本地校验。
2. 随冻结包导出完整页面原屏字段定义，使 Model 无图人工录入可离线渲染、校验。字段定义不包含 Model 业务目标。
3. 保留完整 profile_id 和旧 ID 映射。品牌、控制器、代际、页面、版式元数据由实图证据确认，不批量猜名重命名。
4. 接通温区的 zone_id、zone_source、order，区分设定/实际及启用状态；不得把温区硬塞进压力或注射段位。
5. 保留已知数值的灰显残值及证据；unknown 不猜启用/禁用；单位模板补充与图像原事实分别标记。
6. 页面匹配考虑绑定提示，但冲突图像证据不能被提示强压为成功。未知、停用、冲突、版本不兼容分开报告，后三者不走 generic_fallback 绕过。
7. 新控制器或版式可增加受控 extractor 代码/配置，复用草稿、试跑、冻结发布。UI 只能选已登记 extractor_id，不接受任意 import。
8. 发布不可变包，固定识读实现、模板、字段定义、合同、版本和哈希。停用/回滚追加记录，保留历史回放。Model 接纳成功后才能宣称业务可用。

## 4. 样本与品牌覆盖

首批目标 DEMAG、NISSEI、FANUC、BOLE、YIZUMI、ARBURG。先盘本仓已有原图，不按照片数宣称支持数；去重后标明控制器证据、页面、原图 hash、真值和调参/独立验收用途。伯乐控制器变体、日精界面代际按实际证据登记，不把用户示例当已支持清单。

沿用 human_truth，长尾允许独立商业模型 ai_truth，记录模型版本、提示版本/hash、原图 hash、生成时间和适用字段。与识读开发隔离的冻结样本用于验收；调参见过的图片不能宣传为独立新布局。

单位、角色、启用状态、段序及 Model 目标存在关键争议时进入有来源的仲裁；Reader 负责观测争议，Model 负责业务解释争议。无争议字段继续留存，未决关键字段不能进入自动写入范围。

## 5. 实施对应与验收

- P1 Reader 工作包：基线核对、公共合同扩展和一页已知样本导出；Model 工作包接入同屏人工与识图闭环。
- P2：发布元数据、控制器兼容查询和自动页匹配，供 Model 一次绑定。
- P4：温区及相关时间原屏观测接入，配合 Model 归一化输出。
- P5：真实未支持的控制器/版式适配，先实现识读再试跑冻结，由 Model 接纳并联调。
- P6：按六品牌矩阵逐项补齐。Reader 页面读取通过不等于 Model 工艺写入通过。

Reader 验收至少包括逆序/缺段/重复段、灰显残值、unknown、温区数和顺序变化、重复身份、设定/实际、模板补单位与原图冲突、真实 bbox/变换、未知/停用/不兼容、v1 兼容及稳定 hash。

HTTP、脚本分发和 scripts/feishu_card_assistant.py 等真实调用方均须核查。固定响应单测、真实识读、API 联调、网页保存重开分开留证。具体联合验收 ID 见 Model acceptance.md。

每项跨仓任务事前声明所需 extra repo 和读写权限，复用项目环境。本 Spec 不改变平台现有 worktree/清理机制，不依赖新建临时虚拟环境，不清理原仓或项目环境。

## 本路线的工程实施模式

每张票的实施与独立验收使用 poteto-mode 的项目适配规则。先读已安装技能及 Codex 映射，再读本仓 .agents/playbooks/ap-task-graph.md，校验锚点并选择适用 playbook。验收者核对实际步骤记录和最终行为，不能从启动指令推断模式已经执行。任务依赖、权限和完成状态仍由平台批准快照管理。
