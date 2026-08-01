---
doc_type: PLAN
doc_status: ready
next_action: start_first_slice
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · Workflow Dashboard 队列与文档按需查看

## 背景与目标

现有 Dashboard 已能展示和激活待处理 PLAN，但队列正文与操作按钮同时铺开，信息密度过高。下一轮只整理
现有信息和入口，不新增工作流状态：用户先看到“有哪些内容在排队”，需要时再展开 Slice、正文和操作；任一
队列文档都可一键转换为飞书文档并回发当前会话。

## 交互原则

- 默认只显示分类、数量、文件名、状态和唯一下一步；正文、Slice 详情和次要操作按需展开。
- 队列按 `Inbox / PLAN / HANDOVER` 分类，分类和单项均可折叠；空分类显示 `0`，不占用详情空间。
- PLAN 只展示未完成项；终态 `completed / superseded` 不进入默认队列。
- 不从 Markdown 正文猜状态或 Slice；只使用 workflow contract、YAML frontmatter 和已存在的结构化解析结果。
- 同一能力只保留一个入口：卡片复用现有队列、文档导入、消息投递和权限校验链路。

## S01：统一队列分类与未完成 Slice 摘要

- 将当前 Workflow 项目的 Inbox、未完成 PLAN、相关 HANDOVER 汇总为同一只读队列模型，并按类型分类。
- PLAN 摘要展示当前未完成 Slice；默认只显示 Slice 编号和标题，展开后才显示范围、完成标准与下一动作。
- HANDOVER 展示所属 PLAN、已完成 Slice、`plan_progress` 和 `next_action`，避免与待执行 PLAN 混为一类。
- Inbox 展示待整理条目及来源；不把 Inbox 文本误标成已通过校验的 PLAN。
- 无法可靠解析的字段显示“未声明”，并保留文件查看入口，不猜测补全。

验收：Dashboard 首屏能看出三类各有多少项、哪些 PLAN 尚未完成，以及每个 PLAN 当前待执行的 Slice；未展开时
不显示正文。

## S02：卡片与操作按需展开

- 分类区、单个文档详情和次要控制默认折叠，用户主动展开后才展示完整信息。
- 将 `manual / semi_auto / auto` 归入“自治模式”操作组；默认显示当前模式，展开后再选择具体模式。
- 将文档查看、计划激活等操作按用途分组，避免所有按钮平铺；高风险或改变执行状态的动作仍保留原有确认与权限。
- 折叠只改变展示，不改变队列排序、选中计划、watcher cursor、审批或执行语义。

验收：默认卡片高度明显降低；用户最多经过一次展开即可看到某项详情或自治模式选项，且原有激活与模式切换
行为不变。

## S03：选择文档并一键转为飞书文档

- Inbox、PLAN、HANDOVER 的每个队列项提供“查看飞书文档”；允许先选择一项，再执行一次转换与发送。
- 复用现有 Markdown → 飞书 Docx 导入能力和当前会话消息投递；成功后把文档链接回发当前用户/会话。
- 同一 Git commit、同一路径的重复点击复用已生成文档或幂等结果，避免产生重复副本。
- 转换前固定读取目标 Git ref 中已提交的文件，不读取工作区草稿；文件变化后明确显示版本已更新。
- 导入或发送失败时保留原选择并给出可重试错误，不影响队列和 workflow 状态。

验收：分别从 Inbox、未完成 PLAN、HANDOVER 各选择一个文件，均能收到可打开的飞书文档；重复点击不会无提示
地产生多份副本。

## 非目标

- 不做批量转换、拖拽排序、全文搜索或新的文档存储系统。
- 不改变 PLAN 审批、Slice 推进、自治模式或 watcher 的业务规则。
- 不默认展开完整 Markdown，不在首屏加入更多常驻按钮。

## 验收顺序

1. 用包含 Inbox、多个未完成 PLAN 和 HANDOVER 的真实项目检查默认折叠与分类数量。
2. 展开一个 PLAN，核对未完成 Slice、下一动作和正文按需展示。
3. 展开“自治模式”，分别验证 `manual / semi_auto / auto` 仍走现有控制链。
4. 各选择一种文档并转为飞书文档，确认链接回发当前会话及重复点击幂等。
5. 验证无权限、HEAD 变化、导入失败时不会改变 workflow 状态。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/364_PLAN_20260801_WorkflowDashboard队列与文档按需查看.md` 的 S01；读取目标 HEAD 的
`AGENTS.md`、`docs/workflow/workflow-contract.yaml` 和本 PLAN。完成验证、创建下一 HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
