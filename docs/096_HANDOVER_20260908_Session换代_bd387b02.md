---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: null
slice: null
plan_progress: complete
---

# HANDOVER · Session 换代检查点

- Room：HMI-Reader
- Task：Live Room · HMI-Reader
- Agent：codex, claude, kimi-code, ds
- Git HEAD：5adf2ac96f329ecd7ac17aeab8fb1482ef04266c
- 未完成 PLAN：docs/095_PLAN_20260908_以工艺参数为中心的通用提取.md

## 工作区状态

```text
M AGENTS.md
 M CLAUDE.md
 M hmi_service.py
 M scripts/extract_fields.py
 M scripts/vlm_qwen.py
 M templates/tact.temperature.json
 M tests/test_generic_extraction.py
?? docs/084_HANDOVER_20260825_Session换代_dbd32a78.md
?? docs/087_REPORT_20260907_当前基线核验与PaddleOCRVL评估.md
?? docs/088_HANDOVER_20260908_PaddleOCRVL试验收口与0907PLAN理解.md
?? docs/inbox/
```

## 最近上下文

[2026/9/8 20:35:36] codex: 需要更新 PLAN：这次改变的是识别主线和验收标准，不只是补一个功能。我会先核对现有计划，再把“以参数提取为中心、取消页面匹配前提”的方向写成可执行的新计划，并说明与旧计划的关系。这轮使用文档命名和 ponytail 技能。


旧计划里“先匹配 Profile、失败才调用模型”的主线与新方向冲突，但 082 已完成的通用候选协议可以复用。新 PLAN 会先验证跨布局的参数提取，再接入验证台；正式 Web 写入另行推进，并用留出样本检查是否仍在“打地鼠”。


新 PLAN 已写成 6 个可独立验收的 Slice：基线、提取核心、HTTP 入口、候选保存、参数展示、跨布局验收。计划明确禁止新增页面专用解析分支，也区分了“提取正确”和“允许写入”。我正在检查文档状态和提交范围，准确率门槛目前只是待验证目标。


提交范围已确认只有新 PLAN，GitNexus 暂存区检测为 0 个受影响符号、0 条流程。整个工作区的 HIGH 风险来自已有代码改动，本次未修改或暂存它们。当前仓库没有交接记录所说的 pre-commit 钩子，我会按现有 workflow contract 检查文档字段，并注明未运行原 preflight。


**需要，而且已经写好并单独提交了新 PLAN。** 这次调整的是识别主线：直接提取工艺参数，取消页面分类、模板匹配作为前提。

计划拆成 6 步：

1. 建立七类参数的真值和独立布局留出集。
2. 复用通用候选能力，改进参数、数值及段号关联。
3. 打通不依赖页面匹配的 HTTP 入口。
4. 验证台完整保存候选、证据和纠错。
5. 按参数展示并逐项确认。
6. 用跨布局盲测验收，禁止靠新增页面专用分支过关。

发现：082 的候选协议可复用，但接口已完成不代表真实提取效果达标。新计划明确替代旧方案的“模板优先、模型兜底”和“先做写入”顺序。

本次只完成计划，尚未改识别代码或验证准确率。文档字段、链接、切片和提交范围检查通过；原 workflow preflight 钩子缺失，未运行。

新增文件：[095 PLAN：以工艺参数为中心的通用提取](/data1/code/hmi_data_reader/docs/095_PLAN_20260908_以工艺参数为中心的通用提取.md)  
提交：`5e39395`。当前为草案，下一步从 S01 基线开始。
[2026/9/8 20:55:54] 你: 你改一下你这个plan，他现在触发不了工作流
[2026/9/8 20:57:46] codex: 我会核对 095 PLAN 和仓库的工作流触发约定，修正文档中阻止触发的字段。这轮使用文档命名和 ponytail 技能。


原因已确认：095 仍是 `draft / await_plan_approval`，且缺少 `WORKFLOW_PROMPT` 执行块，按合同不会启动。我会改为 `ready / start_first_slice`，补上只执行 S01 的提示，并校验后单独提交。


工作流校验已通过，识别出的动作是 `start_first_slice`。暂存区只有 095 PLAN，GitNexus 检测无受影响代码符号；现在单独提交，供工作流读取。


已修好并提交：`5adf2ac`。

- 原因：计划仍为 `draft / await_plan_approval`，缺少执行提示块。
- 修复：改为 `ready / start_first_slice`，补齐只执行 S01 的提示。
- 验证：workflow preflight 通过，动作识别为 `start_first_slice`；尚未确认调度器实际启动。

修改文件：[095 PLAN](/data1/code/hmi_data_reader/docs/095_PLAN_20260908_以工艺参数为中心的通用提取.md)。其他已有修改未纳入提交。

〔WORKFLOW_PROMPT_START 标记已脱敏〕
在 `/data1/code/hmi_data_reader` 只执行 `docs/095_PLAN_20260908_以工艺参数为中心的通用提取.md` 的 S01：冻结参数基线与留出样本。先读 PLAN、AGENTS.md 和 workflow contract，保护已有修改；修改符号前做 GitNexus upstream impact 并报告风险。复用评测脚本、原图和真值，交付七类覆盖表、按独立布局分组的开发／留出清单、可复跑评分与初始结果；094 只入开发集。缺样本或真值时记录缺口与阻塞，不编造数据或声称完整验收。运行聚焦检查、GitNexus detect_changes（compare/master 及 staged）、workflow preflight 和 diff 检查；创建合同有效的 S01 HANDOVER，只提交本 Slice。完成后停止，不进入 S02，不改识别生产代码、不部署、不重启、不做正式写入。
〔WORKFLOW_PROMPT_END 标记已脱敏〕

## 下一步

- 在新 Session 中先核对本文件、Git HEAD 和工作区状态，再等待用户下一条指令。
