# HMI 图片与标注

本目录统一管理微调数据。图片和标注是本地数据资产，不随 Git 推送，需要单独备份。

| 路径 | 内容 |
| --- | --- |
| `raw/feishu/20260927/品牌/机台/` | 本次下载的未经改动的飞书原图 |
| `raw/feishu/20260927/manifest.json` | 附件来源、原图路径、SHA256、像素哈希、机台、模具、业务日期、验收状态 |
| `raw/feishu/20260927/selection.json` | 固定的下载候选清单，断点续跑不重新抽样 |
| `raw/legacy/` | 从 `docs/*sample*` 归位的历史原图包，保留原包名与来源文件 |
| `annotations/` | 历史标注包及人工复核队列，状态仍以包内原清单为准 |
| `catalog/` | 已确认／保留样本清单、原库存与复核索引 |
| `catalog/images.jsonl` | 按SHA256聚合的原图索引，列出所有路径、当前批次飞书来源及已训练／保留标记 |
| `../../holdout/`、`../../regression/` | 原有留出／回归基线，保持原位 |

## 使用规则

- 品牌来自飞书字段，不能当成控制器家族标签；同一品牌可能有多个布局。
- 原图不裁剪、不改名覆盖。裁剪、可视化和推理结果放 `output/`。
- 本次批次 `split=null`、`annotation_status=unreviewed`；下载成功只代表图片可解码，不代表字段可读或标注合格。
- 按机台和近重复组完成审查后，再固化 train / validation / test 清单。已有28张训练样本保持训练侧；已分析的评测图不得转成盲测图。
- 全局机台分组须核对不同来源表的机台编号映射，不能只按表内 `group_machine` 自动切分。
- 复用的旧图在 manifest 中指向现存文件，不复制一份假装新增样本。文件哈希去重不替代近重复审查。
- 历史 `confirmed-manifest.json` 的 `dir` 仍按 `output/training-prep/` 解释；旧路径兼容链接保留，原训练入口继续可用。

## 本批下载

从仓库根目录运行 `python3 -m scripts.download_training_images`。使用当前已授权的飞书 bot，只读取源表；不会发消息、回写飞书或启动训练。候选固定为每品牌最新160条记录内，按机台／模具轮转、每品牌最多35张射出保压／储料冷却附件。伊之密跳过；并非整表全量备份。

训练权重和运行快照见 `output/training/`，复核证据见 `output/reviews/`，迁移对账见 `output/organization-20260927/`。不要删除旧路径链接；所有旧引用迁移完才能移除。

下载完成后，可用 `python3 output/organization-20260927/build_catalog.py` 重建本地索引；
`python3 -m tests.check_training_intake` 校验本批附件与本次迁移哈希。
索引只覆盖这里的原图、标注原图和本批复用图，不把整仓截图、裁剪和渲染图都算作训练样本。

## 2026-09-27 返修验收更新

`catalog/training-manifest-20260927-reviewed.json` 现含58张（原28张+本批确认30张），本轮新增15张、478字段，保留既有数值/单位/禁用裁定。默认 `confirmed-manifest.json` 仍为原28张；58张是显式复核清单，未启动训练。2张历史几何通过候选与5份TACT5独立answer继续不入训。

所有bbox按未经EXIF转正的原生像素百分比xyxy解释。样本87267ae828494b31含EXIF=6，24框已完成坐标转换及像素一致性检查；当前读取器直接读取原生像素，与框一致。若以后将图片EXIF转正，必须同步转换框。

上述为15张返修时的冻结快照，详见 [136验收报告](../../docs/136_REPORT_20260927_十五张返修验收.md)。其历史 `check_rework.py` 固定校验58张及当时哈希，不适用于后续确认后的当前清单。

## 2026-09-27 15:58 用户确认更新

用户确认伯乐 Z048 a4bb 与佳明 Z028 468c 均正确。两张已同步为 `human_confirmed/train`，本批32张，显式复核清单共60张；历史待确认归零，5份TACT5仍待包装。默认入口仍28张，未启动训练。

伯乐射退区“终止位置”6 mm实际为松退距离，已写入标注 observations；保留屏幕字段键、数值、单位、bbox。储料段终止位置15/60/100 mm语义不变。

当前验收：`python3 output/reviews/user-confirmed-pair-20260927/check_confirmation.py`；确认原话、前快照和修改清单见同目录 `confirmation.json`、`before/`、`changes.json`。

复核方式固定为 [左右对照复核技能](../../.agents/skills/hmi-review-pair/SKILL.md)；发送使用 [任务话题回复技能](../../.agents/skills/lark-task-topic-reply/SKILL.md)。左原图、右彩框、下方争议文字；回复当前任务根消息并核验 thread_id，不发大群主时间线。

## 2026-09-27 TACT5 入训包装与 LoRA 要求

最新显式训练清单：`catalog/training-manifest-20260927-tact5.json`，共 **65张、2,116字段**（原60张 + TACT5五张244字段）。原60张清单保留为历史版本。

新增标准标注位于 `annotations/annotation-tact5-20260927/`，图片以相对软链接引用原图，不修改或复制原图。沿用专项语义复核、用户灰显裁定和127几何收口；244字段及238框完整保留。只清理答案里与null冲突的“共用压力”“暂保留显示值”等旧说明，并补灰显残留值说明。审核来源和原答案哈希存放在标注元数据；原专项包保留为历史快照，不把其旧pending状态当作标准包装的当前状态。

五张来自Z077/Z078两台机、四个配方组；Z078的0910与0912同组近重复，均留训练侧。另两张暂缓重拍未入清单。已排除reserved文件哈希；这不等于跨来源机台映射、全库近重复及独立评测已经完成，不能将这五张另作盲测。

`catalog/next-training-requirements.json` 固定用户要求：**视觉和文本均使用LoRA，底座冻结，禁止全量微调**。该文件是准备要求，不是训练入口已加载的配置。启动前必须验证两侧adapter进入优化器、具有有限非零梯度并实际更新，以及显存、保存和独立重载。

当前训练脚本默认仍为历史28张且视觉LoRA开关为False，不能直接复跑作为新方案。GitNexus upstream impact仍因数据库43/运行时41不兼容失败，本轮未修改训练函数、未启动GPU训练。先恢复影响分析，再接通新清单和双侧LoRA。

可重跑数据验收：`python3 -m tests.check_tact5_intake`。清理前后文本、分组、读取器输入快照、验收日志与本轮文件清单见 `output/reviews/tact5-intake-20260927/`。
