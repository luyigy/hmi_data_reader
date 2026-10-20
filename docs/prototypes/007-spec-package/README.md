# 007 Spec 包与飞书提审原型

**状态：讨论原型，未接入生产飞书卡片或执行调度。**

## 这次要核对的决定

从经过讨论的 Spec 出发，一个目录收录 Spec、路线说明 HTML、功能原型 HTML、提审用任务图与已发布 ticket 的索引。逐个 Slice 的验收证据进入平台执行账本。飞书承载可打开的文档或附件、角色配置卡、一次确认和后续进度。`548_PLAN` 保留作历史约束来源，不重新进入逐段 PLAN/HANDOVER 审批。

原型文件：

- [route-review.html](route-review.html)：从 `/ap graph propose` 开始，模拟飞书附件、路线卡、角色矩阵、确认与自动接力。
- [feature-prototype.html](feature-prototype.html)：V1 工程师看到的已归档图导入、草稿读回、原图标注和权限失效模拟。
- [architecture-review-prompt.md](architecture-review-prompt.md)：按 pstack `architect`、`blast-radius`、`code-review` 整理的架构审查者 prompt 草案。

把这两个 HTML **作为飞书文件附件**发送，或转换为具有访问权限的飞书文档后再发文档链接。不要把平台机器上的绝对文件路径当成可供用户打开的 URL。Spec 的 Markdown 同理。

## 007 与现有文档如何衔接

当前 [006 Spec](/data1/code/mold-data-webpage-tool/docs/architecture/006_SPEC_20261015_现场图片归集与工艺草稿导入架构.md) 说明架构约定，[007 Roadmap](/data1/code/mold-data-webpage-tool/docs/architecture/007_ROADMAP_20261015_现场图片到工艺草稿纵向切片.md) 说明五个结果和依赖。`548_PLAN` 对 V1 的实图、哈希、Reader 合同、写入和重开的约束有价值，但它的 S01–S05/逐段审批/HANDOVER 是旧执行机制。若此原型方向确认，再由 Agent 统一整理到项目的 Spec 目录并产出 V1–V5 的结果 ticket；无需人为把每个仓内步骤审批一遍。

Matt 的 `to-tickets` 意味着每张 ticket 都是能演示和验收的结果，明确阻塞边。仓内实施是 ticket 下的执行单元，不冒充交付 Slice。007 的边是 V1→V2，V2→V3 和 V5，V3→V4；V3 与 V5 可并行。V1 前实图与冻结基准是真正的前置证据，不应伪造为已满足。

## 与现有平台的差距

| 环节 | 现在 | 原型要确认的目标 |
| --- | --- | --- |
| 文档入口 | JSON 路线与文字卡 | 一个 Spec 包，附路线说明 HTML、功能原型 HTML、Gitee ticket 索引；卡片引用可访问的飞书文件或文档 |
| 角色分配 | `/ap graph role` 命令改派 | 飞书卡片中按仓内执行选实施 harness，按 Slice 选架构复核和测试验收 harness；建议值可批量填充，再逐项覆盖 |
| 验证 | 显式检查命令、固定提交检查与 Agent 结构化结论 | 项目级 `verify` skill 驱动真实用户路径并留证据；与 Slice 验收标准绑定 |
| 架构审查 | 一个只读 Agent 提示词，检查范围与共享接口 | 独立角色引用明确的架构审查 playbook，列出变更影响、公共边界、旧场景回归，并给出可追溯结论 |
| 提审与启动 | 卡片确认 JSON 快照后启动 | 同一次确认冻结 Spec 包版本、ticket 图、角色、验收策略；之后按依赖自动执行 |

`create-verification-skill` 生成的项目级 `verify` 是验证真实应用的驱动说明，不是一个可以凭名称自动通过的验收者。平台需要记录实际驱动步骤、截图/日志、持久化结果和失败原因，再决定是否释放后继。架构审查也要记录所审查的固定提交组合及影响结论。每个执行者、审查者、验收者的 prompt 应分别注入同一份已冻结的 Spec/ticket 引用与各自职责，避免从历史 PLAN/HANDOVER 拼装下一轮指令。

角色矩阵推荐 **行＝Slice 中的仓内执行，列＝实施／架构审查／测试验收**：职责固定，空缺与兼任容易发现；同一 Slice 的架构和验收单元格跨仓内执行合并。反过来让 harness 占列，更适合用作“每人承担什么”的负载核对视图，编辑时会让职责散在各列。原型可在两种视图之间切换。

建议值应来自父任务房间里已登记的角色，而不是写死某个 harness。这个房间当前有 Codex（implementer）、Antigravity 与 Pi（tester）、Kimi Code（researcher），没有 architect。原型因此只建议实施者和测试验收者；架构审查者留空，人可设置一次项目默认并按 Slice 覆盖。实施者兼任同片架构审查时原型会提示；生产实现还需定义是否硬性禁止这种兼任，以及允许的远端 harness 范围。

真实命令 `/ap graph propose <Spec 路径>` 现在只唤醒 Agent 准备 JSON 路线；原型展示的是目标回执：Agent 整理 Spec 包和 tickets，Bot 把 HTML/Markdown 附件或可访问飞书文档发送到父任务话题，再发带矩阵的路线卡。人调整下拉框后点击“确认并启动”，平台冻结包版本、图和角色。当前生产卡尚不发送这些附件，也没有矩阵下拉框；它只支持 `/ap graph role` 命令改派。

## 新一轮讨论：Spec 选择、模式与自动推进

建议在 **mold 项目仓**设 `docs/specs/现场图片到工艺草稿/`，内含 `spec.md`、`route-review.html`、`feature-prototype.html`、`route.json`、`tickets/index.md`。`route.json` 是待提审的依赖图；`tickets/index.md` 记录 Gitee Issue ID 与 Spec 版本。`007_ROADMAP` 与 `006_SPEC` 是迁移输入，不需要让 `docs/architecture/` 或 `docs/dev/` 的文件变动成为新自动化信号。提审卡的下拉列表从项目登记的 Spec 根目录列出“已就绪”的包，并显示版本和来源；不能遍历任意文件名当作可执行提议。

Matt `to-tickets` 的结果取决于仓库配置：**mold 仓配置为 Gitee Issues**，一张纵向 Slice 是一条可演示、可验收的 Issue，并在正文写 `Blocked by`；平台仓配置为 GitHub Issues。目录中的 ticket 文件可保留审阅草稿或已发布 Issue 的索引，但不能与 Gitee Issue 及平台执行账本同时充当可变的运行真相。

提审后由人一次确认 Spec 包的 Git 提交/内容哈希、V1–V5 ticket 图、每片模式和角色。平台写入不可变运行快照。**任务图服务监控数据库状态，不监控 Spec 文件夹或 `docs/dev` 的 front matter**：实施提交与集成记入执行账本，节点达到该片已确认的完成条件后，服务计算依赖 frontier 并放行后继。Spec 的后续改动生成新提议版本；不会静默改变运行中的图。

建议模式由卡片按风险填好，人可按 Slice 覆盖：

| 模式 | 必需角色与完成条件 | 对后继的含义 |
| --- | --- | --- |
| 完整 Full | 实施者、独立架构审查者、测试验收者；三方所需证据通过 | 节点“已通过”后放行 |
| 精简 Lean | 实施者、测试验收者；不要求单独架构审查 | 检查与验收通过后放行 |
| 仅实施 Implement | 实施者；仍需提交、固定版本集成与执行记录，但不运行独立测试验收 | 标“已交付（未验收）”，按**事先批准的模式**允许后继接力；父任务不能把它报告成已验收交付 |

这与生产实现仍有差距：当前提议卡强制每片架构审查者，任务图节点只有自动/Agent/人工验收，没有“已交付（未验收）”状态；因此模式切换不能只改前端下拉框。需要同时修改快照校验、节点状态和后继放行规则。旧 watcher 已停用；无需重开它来监控新目录。

## 待人判断

1. Spec 包的两个 HTML 是否正好覆盖你想审的“交付路线”和“用户功能”？功能原型目前只演示 V1，后续 Slice 可按 ticket 增补场景。
2. 飞书卡上的“建议分配 → 逐项覆盖 → 一次确认”是否比为 10 个仓内任务、5 个架构复核和 5 个验收逐个空白选择更合适？
3. 通过架构复核、项目 `verify` 和 Slice 验收前，后继保持等待；是否有某片必须强制人工裁定实图基准或字段争议？

确认这些体验后，再改生产飞书卡、Spec 包结构和运行时 prompt。当前原型不创建真实 ticket，也不启动 007 实施。

## 007 Issue 接力逻辑原型

[dependency-runner.html](dependency-runner.html) 用单文件演示三个场景：V1→V2→V3/V5 的正常接力、提前关闭 Issue 不能启动后继、V3 失败时 V5 独立继续。它区分四层：版本化 Spec 包是审议输入；Matt tickets/各仓 Issue 是公开工作单；批准后的任务图快照是依赖和角色的固定定义；执行账本是放行依据。跨 GitHub/Gitee 仓库的 Issue URL 和状态可回写供人追踪，但不能用任意一个仓库的 Issue 关闭事件替代跨仓集成与纵向验收。

建议审批前生成可审阅 ticket 草稿，审批时冻结图并幂等发布/绑定主仓的 Wayfinder map、V1–V5 结果 Issue 和各仓实施 Issue。主仓 Gitee Issue 是跨仓结果的索引；各仓 Issue 由对应仓库的 tracker 配置决定位置。绑定关系存于运行快照/账本，Spec 包的 `tickets/index.md` 可保存可读索引但不是运行状态。平台在每个节点满足事先批准的完成条件后，由 coordinator 原子记录通过、重算 frontier，并为新放行仓内任务创建子任务、独立 worktree 和 Session；服务重启用幂等键补做未完成派发。Issue 投影同步失败可以重试；Issue 被人工关闭、标签变化或 Webhook 重复均不直接改变节点通过状态。

007 老文档提出在一条 Gitee Wayfinder map 下维护 V1–V5。Matt 的 wayfinder `frontier` 描述是“map 顺序中首个开放且无 blocker 的 ticket”，适合单个领取者的导航；007 的 V3 与 V5 必须同时启动，因此平台不能照搬这个单 ticket 领取规则。它应计算全部前置已满足的节点，生成一个并行 frontier。Issue 的 `Blocked by` 文字是可读镜像；跨 tracker 的边和放行规则以冻结图为准。

原型里的“模拟 Agent 完成”按钮代表外部 Agent 结束事件，不是人工集成按钮。当前生产协调器在 Agent 返回 `completed` 后会取得各仓锁，自动在 detached staging worktree 合并、执行仓内检查，再推进本次运行的 integration ref 并记录 `execution_integrated`。该 ref 不会自动移动仓库 `main`。若合并冲突、检查失败或执行状态不确定，则记录异常并暂停受影响分支；只有预先选择 `human` 验收的 Slice 才在正常路径等待人确认。原型现在明确显示这个区别。
