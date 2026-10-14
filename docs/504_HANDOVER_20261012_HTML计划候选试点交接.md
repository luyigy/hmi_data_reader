---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/503_PLAN_20261012_HTML计划与自动接续可靠性.md
slice: S01
plan_progress: complete
---

# HANDOVER · HTML计划候选试点交接

## S01 结果

已完成 HTML PLAN 候选的最小试点：

- `npm run workflow:new -- --kind plan --title <主题> --format html` 可生成 phase 候选；未指定 `--format` 时仍生成 Markdown PLAN，HANDOVER 仍为 Markdown。
- HTML 文件用开头的 YAML 注释保存现有合同字段，用语义化标签展示标题与 Slice，用不可见的 `template` 保存下一 Session Prompt。生成器仍从目标 HEAD 读取合同和模板。
- 校验器接受显式提交的 HTML 候选，继续校验字段、Slice、Prompt、编号及常见活动内容；旧 Markdown PLAN/HANDOVER 继续通过。watcher 的默认候选选择保持 Markdown，HTML 样例不会被派发。
- [可打开的样例](workflow/examples/001_PLAN_20261012_HTML计划候选样例.html) 位于 watcher 不监控的示例目录。Chrome 无头打开检查显示了标题、S01 和验收内容，隐藏元数据与 Prompt 未显示；用户对可读性的评价仍待收集。

## 飞书入口补充

用户指出仓库内部的 `npm run workflow:new` 不是飞书操作入口。现已接入 `/ap plan --format=html <需求>`：它沿用现有房间内的计划讨论，由主持 Agent 调用仓库生成器填写 HTML 候选；平台提交前校验该文件，并在消息里明确提示“暂不进入 watcher 审批或自动派发”。原 `/ap plan <需求>` 仍生成正式 Markdown PLAN。HTML 候选的 `next_action` 必须为 `await_approval`，校验器拒绝执行动作。

### 本轮实际改动与使用结果

本轮分三次追加提交，分别为 `c10b7ba`（HTML 候选骨架与校验）、`1db257d`（样例及本交接）、`ca16357`（飞书入口）。具体改动如下：

| 部分 | 主要文件 | 现在能做什么 |
| --- | --- | --- |
| 文档合同与生成 | `docs/workflow/workflow-contract.yaml`、`docs/workflow/templates/PLAN-candidate.html`、`scripts/new-workflow-document.ts` | 显式指定 `--format html` 时生成一份 HTML PLAN 候选；默认 PLAN 与 HANDOVER 仍是 MD。 |
| 校验 | `src/lib/scheduled-jobs/workflow-validator.ts`、`scripts/generated/workflow-validator.cjs` | 校验 HTML 注释中的合同字段、Slice、Prompt 和静态内容；HTML 候选只能等待审批，不能声明启动执行。 |
| 飞书入口 | `src/lib/feishu-plan.ts`、`src/lib/live-room-workflows.ts`、`src/lib/feishu-help.ts` | 在飞书发送 `/ap plan --format=html <需求>` 可启动候选计划讨论，完成后消息返回已提交的文件路径。 |
| 示例与验收 | `docs/workflow/examples/001_PLAN_20261012_HTML计划候选样例.html`、对应测试和 `docs/workflow/AUTOMATION_GUIDE.md` | 可从仓库打开样例查看排版；自动测试覆盖生成、校验、飞书命令解析与 watcher 不派发。 |

一次计划只生成一种格式：`/ap plan <需求>` 生成正式 MD；`/ap plan --format=html <需求>` 生成 HTML 候选，不同时生成同名 MD。HTML 候选需从仓库取得 `.html` 文件并在浏览器打开，飞书内尚无 HTML 预览或审批卡。PLAN 写作规范未改，因而本轮没有解决计划内容不可靠、伪阻塞等问题。`npm run workflow:new` 是 Agent 内部生成文件的命令，不是用户在飞书输入的命令。飞书服务未在本轮重启，`/ap plan --format=html` 只经过本地测试，尚未做飞书端到端验收。

## 验证

- `npm run test:new-workflow-document`、`npm run test:workflow-validator`、`npm run test:git-history-guard`、`npm run test:workflow-watcher`、`npx tsc --noEmit`、`npm run check:long-files` 均通过。
- 样例经 `npm run workflow:validate -- --preflight docs/workflow/examples/001_PLAN_20261012_HTML计划候选样例.html` 通过；测试覆盖 HTML 与 MD 共用编号、HTML 不进入 watcher、无效元数据及脚本拒绝。
- Chrome 无头截图写于 `/tmp/html-plan-candidate.png`，已人工查看页面。截图是本机临时文件，样例 HTML 已纳入本次交付。

## 后续边界

本试点不切换正式 PLAN 默认格式，也不修改 watcher、审批卡和飞书预览。HTML 目前只支持 phase 候选；正式推广需根据样例反馈另立计划，补齐所有生产入口、审批与安全预览，并回归历史 Markdown 文档。减少伪阻塞和审查后自动修订也留给独立计划。

因 `workflow:new` 按合同只读取已提交的 HEAD，本 Slice 先提交了合同、生成器、校验器和测试（`c10b7ba`），随后才用正式命令生成本样例和 HANDOVER；Git 历史保持只追加。本机现有 `config/runtime-environments.json` 改动和视频目录未纳入本次交付。平台 watcher 当前处于运行态覆盖关闭状态，提交本 HANDOVER 不会自动启动下一 Session。
