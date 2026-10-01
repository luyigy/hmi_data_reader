---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: null
slice: hotfix
plan_progress: complete
---

# HANDOVER · LiveRoom脚注与成员设置及实际模型遥测待办交接

## 当前状态与用户要求

2026-10-01 18:39，用户要求本 Session 先写交接并提交已有更改；Codex 与 pi-agent 回复底部仍未展示实际模型和思考强度，下一 Session 解决。本轮只核对、验证、整理交接和提交，没有继续实现遥测，没有重启服务、推送远端或启动下一 Session。

这是对 `docs/483_HANDOVER_20261001_LiveRoom消息包装与遥测验收及角标设置交接.md` 的续接。通过 workflow:new 使用仓库终态模板生成骨架，再调整为独立 hotfix / plan: null / next_action: none。仅本次收口完成，不表示实际值展示已完成，也不表示 PLAN 481 的 S07 或原生终端计划完成。生成器要求传 PLAN/Slice，仅用于取得骨架，不建立实际执行关系。

## 已有改动与未完成的关键问题

- 新增 live-room-footnotes.ts，从 participant.controlMetadata 读取归一化遥测，生成回复快照；接入普通回复、plan/workflow 阶段、网页消息、飞书最终卡片和 relay。内容包含模型、请求设置、上下文口径、token、耗时与采集时间。
- 归一化遥测新增 model、outputTokens 可选字段及校验。Codex 目前只新增输出 token，没有接入实际模型；Kimi 和 Antigravity 适配器可以转入来源提供的模型字段。
- 成员面板和 /ap members 展示最近模型/上下文信息；新增通用 /ap model-config，保留 /ap codex-config。复用现有成员字段，未迁移数据库。
- 新增 Pi Provider/模型/强度表单和合法值校验。设置经过成员 API、Harness 到 Pi CLI，覆盖新建/恢复及 JSON/RPC/print 路径。配置下轮生效，不能据此证明当前底层实际采用的值。
- **实际模型与强度仍未完成。** buildLiveRoomFootnotes 中思考强度直接写死“实际值未确认”；live-room-members.ts 的 modelLabel 也写死强度未确认。NormalizedContextUsage 没有实际 reasoningEffort 字段。Codex 未填 model；Pi adapter 尚无归一化模型/强度遥测接入。这是采集链缺口，单改文案或重启不能解决。
- “继承默认”只表示平台请求未覆盖，不能等同于底层模型/强度。历史消息 footnotes 是快照，后续修改设置不能覆盖旧回复。

## 下一 Session 的实现与验收入口

先追踪真实运行链，再在公共采集处补齐本轮有效值，不要在每个 UI 单独猜测：

1. Codex：检查 src/lib/real-agents/codex-app-server.ts、codex-telemetry.ts、harness/adapters/codex.ts 的运行/恢复回执与事件。采集实际模型、强度，关联本轮和 Session；不要用成员设置直接填充“实际值”。
2. Pi：检查 src/lib/real-agents/pi-agent.ts、pi-rpc.ts、harness/adapters/pi-agent.ts。确认 RPC state、事件或 Session 记录哪个能可靠报告实际 provider/model/thinking，再沿既有持久化链传给展示层。继承默认、显式覆盖、恢复会话均需覆盖。
3. 复用 harness/types.ts → participant.controlMetadata → context-usage.ts / live-room-footnotes.ts → live-room-members.ts / 网页 / 飞书链路。若模型状态与 token 遥测采集时机不同，不应因没有 token 而无条件丢掉已有可信模型状态；按实际证据选择最小改动。
4. 保留请求值与实际值的区分、Session/轮次绑定、新鲜度和未知降级。缺失/过期/跨会话信息不得伪装成本轮值；历史回复不能被新设置改写。
5. 自动测试需证明真实事件/回执字段确实到达脚注与成员面板，而不是只给 format 函数传人工构造 model。再对 Codex、Pi 各做一次真实运行和续接，比较底层回执、网页、飞书是否一致；无法获取证据时明确未验收。

用户提供的 Pi 上一轮自查结论为 zai / glm-5.3 / high，来自当时的进程参数、环境、全局 settings 与网络检查；本轮未独立复测。可作为排查线索，不能硬编码，也不能把连接 z.ai 的 IP 当作具体模型/强度的充分证明。Pi 报告 provider 模型映射有 max，但当前平台 Pi 档位为 off/minimal/low/medium/high/xhigh；应区分 Pi CLI 档位与 provider 映射后再判定，不直接扩充枚举。

34% 的既有解释是最近一次调用输入 89,075 / 窗口 258,400，约 34%；不是此刻实时占用率，也不是累计会话用量。当前任务室提示遥测缺失，不能复用旧百分比当本轮水位。

## 本轮验证

- npm run check:long-files：通过，无文件达到 1000 行阻断阈值。
- npx tsc --noEmit：通过。
- git diff --check：通过。
- 6 个测试文件通过：live-room-footnotes、pi-member-settings、harness-context-usage、normalized-context-usage、feishu-help-command、feishu-progress-system-info。
- 运行方式：TS_NODE_BASEURL=.，TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}'，node -r ts-node/register/transpile-only -r tsconfig-paths/register tests/<名称>.test.ts。
- pi-rpc-native：跳过，未设置 PI_RPC_NATIVE_BIN；不能宣称真实 Pi 冒烟通过。Pi 设置测试使用模拟可执行文件验证参数路径，不验证模型供应商实际响应。
- 暂存本文后运行 npm run workflow:validate -- --preflight 本文路径：通过，action=none。

未做真实模型请求、浏览器端到端或飞书发送验收。服务仍需在合适时机由运维加载新代码：飞书 agent-platform-feishu.service；网页开发服务通常自动加载，必要时重启 agent-platform-dev.service。本轮未执行重启。

## 提交范围

以下为本任务已有代码/测试更改，另新增本文；本轮没有编辑生产代码。

- `src/app/api/live-rooms/[id]/members/[memberId]/route.ts`
- `src/components/live-room/LiveRoomDetailsPanel.tsx`
- `src/components/live-room/LiveRoomThread.tsx`
- `src/components/live-room/live-room-workspace-models.tsx`
- `src/components/live-room/use-live-room-controller.ts`
- `src/lib/context-usage.ts`
- `src/lib/feishu-command-parser.ts`
- `src/lib/feishu-help.ts`
- `src/lib/feishu-live-room-commands.ts`
- `src/lib/feishu-live-room-relay.ts`
- `src/lib/feishu-progress.ts`
- `src/lib/feishu.ts`
- `src/lib/harness/adapters/antigravity.ts`
- `src/lib/harness/adapters/codex.ts`
- `src/lib/harness/adapters/kimi-code.ts`
- `src/lib/harness/adapters/pi-agent.ts`
- `src/lib/harness/types.ts`
- `src/lib/live-room-codex-settings.ts`
- `src/lib/live-room-delivery-execution.ts`
- `src/lib/live-room-delivery-processing.ts`
- `src/lib/live-room-members.ts`
- `src/lib/live-room-types.ts`
- `src/lib/live-room-workflows.ts`
- `src/lib/real-agents/antigravity-context.ts`
- `src/lib/real-agents/pi-agent.ts`
- `src/types/index.ts`
- `tests/harness-context-usage.test.ts`
- `src/components/live-room/PiMemberModelSettings.tsx`
- `src/lib/live-room-footnotes.ts`
- `tests/live-room-footnotes.test.ts`
- `tests/pi-member-settings.test.ts`

以下保持原状，不属于本任务提交：config/runtime-environments.json、config/runtime-environments.hmi.lock、docs/inbox/482_ISSUE_20260928_服务监控Agent决策审计与历史保留策略研究.md、docs/gitnexus-wiki/、output/。上次 HANDOVER 483 也已记录这些独立工作区内容，勿用 git add . 混入。

## 下一 Session 手动 Prompt

仓库校验器禁止终态 none 携带自动化 Prompt 标记，因此沿用 HANDOVER 483 的普通正文交接方式，不发 WORKFLOW_READY，不自动启动新会话。

读取 `docs/484_HANDOVER_20261001_LiveRoom脚注与成员设置及实际模型遥测待办交接.md`、`AGENTS.md` 和 `docs/workflow/workflow-contract.yaml`；本轮解决 Codex 与 pi-agent 在回复脚注及成员面板中未显示实际模型、思考强度的问题。从真实运行回执、事件或 Session 状态采集并验证本轮有效值，不能用请求配置或全局默认冒充实际值；覆盖继承默认、显式覆盖、续接和未知降级，保留历史快照及上下文口径。不要启动 PLAN 481 原生终端工作。完成验证、写交接并提交后停止。
