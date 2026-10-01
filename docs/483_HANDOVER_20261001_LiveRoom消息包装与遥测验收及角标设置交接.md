---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: null
slice: hotfix
plan_progress: complete
---

# HANDOVER · Live Room 消息包装与遥测验收及角标设置交接

## 当前结果

用户在任务室于 2026-10-01 16:59:47 确认“这些改动都 OK”，授权提交并写交接，之后手动重开 Session。已提交代码 `3848bcb`（oss-prep），本轮只核对、验证与提交已有改动，没有增加新的产品功能，也未重启服务、推送远端或触发下一 Session。

本次为独立收口，不代表 PLAN 481 的 S07 或整个原生终端计划完成。按 workflow:new 从仓库终态模板生成骨架后，改为 plan: null / slice: hotfix / next_action: none。PLAN 481 仍是相关背景，未修改其状态。仓库校验器禁止终态 none 包含自动化 Prompt 标记，因此下一会话说明放在普通正文中，供用户手动启动。

## 已交付链路

- Antigravity 原始 JSON 流经 live-room-progress → live-room-raw-output 提取回答、最近工具与过程信息，飞书使用同一张回复卡更新并收尾；正文、折叠系统信息、底部耗时与本轮 token 分区。完整回答仍在任务室，卡片预览按请求编码体积截断；输出经过脱敏。最终回复跳过重复飞书 relay。
- Antigravity 只以 result 回答结算，缺结果、拒绝权限和失败显式报错；原始 JSON 不再误触发文字权限问答。追加消息通过中断当前轮、退出后恢复同一 conversation 实现，不是同进程原生 stdin steering；显式停止阻止待恢复轮，按消息 ID 去重。
- NormalizedContextUsage 将数值口径、可信度、sessionId、采集时间统一到 Harness 契约。Codex/Kimi/Antigravity 在适配器内转换，执行层统一持久化，成员水位和 prompt 告警统一读取。
- context-usage.ts 校验 session 匹配、数值、15 分钟新鲜度与未来时间戳；不合法的新字段不回退复活旧数据。旧 Codex/Kimi 兼容集中在 context-usage-legacy.ts；旧 Antigravity 记录缺会话绑定，不作为当前水位。
- Codex 命令中心已有模型/思考强度命令说明。本次没有新建通用模型切换 UI。

## 验证与限制

用户人工验收来自提供的任务室记录；本次没有再发送飞书消息或发起真实模型请求。以下 11 个测试文件全部以 node + ts-node/register/transpile-only + tsconfig-paths/register 运行通过：

- normalized-context-usage、harness-context-usage、context-watermark-warning。
- antigravity-agent、antigravity-steering、live-room-raw-output。
- live-room-progress、live-room-steering、feishu-help-command。
- feishu-progress-system-info、acpx-long-file-runtime-context。

复跑环境：TS_NODE_BASEURL=.，TS_NODE_COMPILER_OPTIONS={"module":"commonjs","moduleResolution":"node"}；文件位于 tests/<名称>.test.ts。npx tsc --noEmit、npm run check:long-files、git diff --check 均通过，无达到 1000 行阻断阈值的文件。本交接暂存后另执行 workflow:validate -- --preflight。

没有收口阻塞，但“底层已接遥测”不等于每次运行都能得到可信百分比。Antigravity 未报告窗口时标记 assumed_window，只有 measured_exact 且非 cumulative 才能用 contextUsagePercentage 生成水位；turn_input 表示最近一轮输入，不能称为当前完整 Session 占用。遥测缺失、过期、跨 Session 时保持未知，不用房间消息数冒充 token 或百分比。当前任务提示遥测缺失亦不能据此宣称真实水位已恢复。

## 下一轮范围与 footnotes 位置建议

把角标/卡片底部展示与模型、思考强度切换放在下一 Session 一起推进，复用这轮数据口径。以下是待实施布局，不是已上线功能：

| 位置 | 常驻内容 | 展开内容或交互 |
| --- | --- | --- |
| 每个 Agent 回复底部第一行 | 本轮模型 · 思考强度 | 设置入口；未知或不支持明确标示；待生效值与本轮实际值分开 |
| 第二行 | 上下文或最近一轮输入：已用 / 窗口（可信时显示百分比） | metricKind、confidence、更新时间；窗口未确认不显示可信百分比 |
| 第三行，空间不足可折行 | 本轮输入 / 输出 token · 耗时 | 累计 token 仅数据源实际提供时独立标明累计范围 |
| 折叠系统信息 | 最近工具与过程 | 保留现有折叠内容；不要把关键模型/水位藏在折叠内 |

副节点/成员卡片与消息脚注共享字段含义，但生命周期不同：成员卡片表示当前会话最近有效状态，历史消息脚注应保留该轮快照，不能随着之后切模型而改写。窄屏允许折行，信息不能只靠颜色。

优先定位并复用：

- src/lib/feishu-progress.ts 的 buildReplyCard / note 与 src/lib/live-room-raw-output.ts 的 result.usage：当前 Antigravity 回复底部。
- src/lib/feishu-live-room-relay.ts：其他成员最终回复的 note；需要覆盖每个 Agent，不能只改 Antigravity 卡片。
- src/components/live-room/LiveRoomDetailsPanel.tsx：已有成员水位展示，检查副节点实际入口再接字段，不另建重复面板。
- src/lib/live-room-members.ts、src/lib/context-usage.ts、src/lib/harness/types.ts：统一遥测来源与可显示百分比规则；必要时把口径与可信度显式传至展示层，不解析说明文案。
- src/lib/live-room-codex-settings.ts、src/lib/feishu-live-room-commands.ts：已有 Codex 成员设置和 /ap codex-config；先追踪保存→下一轮执行→实际 CLI 参数链路，复用而非重写。
- docs/481_PLAN_20261001_LiveRoom原生模式Antigravity优先试点.md 的 S05/S06：通用设置的背景约束，不因引用而自动执行 S02–S07 或引入原生终端。

先确认各 Harness 的模型/强度能力、可确认的本轮值和下一轮生效语义；无能力或无法回读时显示“不支持/未确认/上次确认”，不要把配置意图当实际生效值。运行中修改不改变本轮，权限和模型档位校验仍须保留。若通用设置与 UI 超出一 Session，按实际边界先立小 PLAN，再逐 Slice 交付；不要为角标重做执行架构。

下一轮验收至少覆盖：多 Agent 不串成员/Session、历史回复不被新设置改写、缺失/过期/假设窗口不显示虚假水位、累计 token 不做上下文占比、模型/强度待生效与本轮状态区分、非法设置与无能力降级，以及窄屏和折叠后的可读性。

## 未纳入本次提交的工作区内容

config/runtime-environments.json、config/runtime-environments.hmi.lock、docs/inbox/482_ISSUE_20260928_服务监控Agent决策审计与历史保留策略研究.md、docs/gitnexus-wiki/、output/ 属于其他配置、文档或生成物，保留原状。不要下一轮使用 git add . 混入。

## 本次代码提交文件

- src/lib/acpx/harness-events.ts
- src/lib/acpx/prompt.ts
- src/lib/acpx/runner-harness.ts
- src/lib/acpx/runner-participant.ts
- src/lib/context-usage-legacy.ts
- src/lib/context-usage.ts
- src/lib/feishu-help.ts
- src/lib/feishu-live-room-relay.ts
- src/lib/feishu-progress.ts
- src/lib/harness/adapters/antigravity.ts
- src/lib/harness/adapters/codex.ts
- src/lib/harness/adapters/kimi-code.ts
- src/lib/harness/types.ts
- src/lib/live-room-delivery-execution.ts
- src/lib/live-room-delivery-processing.ts
- src/lib/live-room-delivery.ts
- src/lib/live-room-members.ts
- src/lib/live-room-progress.ts
- src/lib/live-room-raw-output.ts
- src/lib/live-room-steering.ts
- src/lib/real-agents/antigravity-agent.ts
- src/lib/real-agents/antigravity-context.ts
- tests/acpx-long-file-runtime-context.test.ts
- tests/antigravity-agent.test.ts
- tests/antigravity-steering.test.ts
- tests/context-watermark-warning.test.ts
- tests/feishu-help-command.test.ts
- tests/feishu-progress-system-info.test.ts
- tests/harness-context-usage.test.ts
- tests/live-room-progress.test.ts
- tests/live-room-raw-output.test.ts
- tests/live-room-steering.test.ts
- tests/normalized-context-usage.test.ts

另新增本 HANDOVER。

## 下一 Session 手动输入

读取 `docs/483_HANDOVER_20261001_LiveRoom消息包装与遥测验收及角标设置交接.md`、`AGENTS.md` 和 workflow contract；下一轮重点做成员模型/思考强度切换，并统一规划和实现各 Agent 角标、回复 footnotes 的模型、强度、上下文与 token 展示。先复用现有 Codex 设置和归一化遥测，区分本轮实际值、待生效值及遥测可信度；不要自动启动 PLAN 481 的原生终端工作。按实际范围拆分、验证并交接。
