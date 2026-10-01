---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: docs/485_PLAN_20261001_LiveRoom四类Agent实际模型与思考状态遥测修复.md
slice: S02
plan_progress: in_progress
---

# HANDOVER · LiveRoomCodex本轮模型与思考状态S02交接

## 结果与边界

完成 PLAN 485 的 S02：Platform Local Codex 的 app-server / exec JSON 新建、续接结果，现在能通过 S01 runtimeState 接口回传本轮模型和原生 effort。只读取运行器 rollout，不把请求参数、线程回执、旧 token 或 Agent 自述当作实际值。

用户强调 Codex 是主力，风险大时优先其他 Agent。本次评估后采用执行完成后的独立只读采集：执行层仅返回已经存在的 turn ID；未改变启动参数、权限、steering、停止、超时、fallback 决策。未重启任何服务、部署、推送、修改真实房间 metadata、发送飞书消息或启动下一 Session。线上房间/网页/飞书整链验收仍属于 S06，不宣称已上线。

本交接由 `npm run workflow:new -- --kind handover --plan docs/485_PLAN_20261001_LiveRoom四类Agent实际模型与思考状态遥测修复.md --slice S02 --title LiveRoomCodex本轮模型与思考状态S02交接` 生成。按手动分 Slice 执行边界，将默认 next_slice 改为 none 并删除自动化 Prompt 标记；S03–S06 未实施，PLAN 485 保持原状。

## 实现与安全边界

- `src/lib/real-agents/codex-app-server.ts`：结果增加现有 activeTurnId，不更改任何 RPC、请求设置或生命周期。
- `src/lib/real-agents/codex-agent.ts`：可选 turnId 类型与新建结果透传；续接本来直接透传底层结果。
- `src/lib/real-agents/codex-runtime-state.ts`：只在本执行实际 CODEX_HOME 的 sessions 内按精确 thread UUID 找唯一 rollout；校验 session_meta.id、当前执行时间范围内的 task_started、对应 turn_context。app-server 使用本次回执 turn ID；exec JSON 没有原生 turn ID，所以必须只有一个本次启动的 turn 且具有 task_complete，多轮歧义降级未知。保留源 timestamp，按当前 turn 的较新 context 整条替换，不跨轮继承缺失字段、不从工具输出取值。
- `src/lib/harness/adapters/codex.ts`：新建/续接成功后采集，再经原有 runtimeState 通路返回。采集 home 使用 workflowBoundary 最终改写的 codexHome（如存在），不是改写前请求路径；Bubblewrap 沿用既有挂载，不新增例外。
- 模型/effort 不依赖 token；provider 不从旧 session_meta.model_provider 补值。证据明确标记 `runner` / `codex_rollout.turn_context`，只证明运行器本轮报告，不能证明供应商内部最终路由。
- 缺失/损坏/多文件歧义/外部文件软链接/非当前轮记录均不提供状态。ephemeral 无持久化 rollout，保持未知。读取异常只记类别，不影响任务成功，不持久化原始日志。
- 读取单文件限 64 MiB，流式读取超时 2 秒；超限保持未知。目录枚举限实际 home 的 sessions，当前按目录线性枚举文件名；极大归档需要索引时再优化，不扫描全机挑“最近文件”。

4 个生产文件和 2 个测试文件构成 PLAN 已声明的两个传输到共同 adapter 的单一结果通路，无新依赖、数据库迁移或公共类型变更。GitNexus 对明确 UID runCodexAppServer 的 upstream 报 LOW：2 个直接调用、共 5 个受影响符号。已用 rg 核对全部调用者及共享结果读取；索引结果不替代源码检查。

## 验证

离线测试：

- `tests/codex-runtime-state.test.ts`：真实 CLI 0.153.2 脱敏记录形状；旧轮、跨 session、错误 turn、缺少本轮开始、未完成 exec、并发歧义、正文伪装、损坏行、非法字段、模型变更、缺字段清除、过期事件不能覆盖较新观测；真实文件读取、指定 home、缺失文件、ephemeral、重复 rollout、外部软链接。以 mock native 结果驱动实际 adapter → runtime metadata 持久化 → collectLiveRoomFootnotes，覆盖两个入口的新建/续接及 workflow 改写 home，不捏造 token。
- 已有 app-server lifecycle/isolation、codex-steering（停止、超时、竞态、续接、fallback）、codex-event-parser、codex-home、runtime-environments 测试通过。
- S01 公共 runtime-state、harness-context-usage、normalized-context-usage、live-room-footnotes 回归通过；包含失败降级、CAS、长轮次、历史脚注快照和成员标签。
- TypeScript 无输出检查、长文件守卫、diff whitespace 检查通过；无文件达到 1000 行。文档在暂存后执行 preflight，通过后仅提交本 Slice。

真实 CLI + 模拟供应商：`tests/codex-runtime-state-native.test.ts` 的 CODEX_RUNTIME_NATIVE=1 使用本机 codex-cli 0.153.2 和 loopback Responses fixture。两个入口均验证新建继承 `gpt-5.4 / medium`、续接显式覆盖 `gpt-5.4-mini / low`；请求、rollout 与回传字段逐项一致。额外 CODEX_RUNTIME_BWRAP=1 在实际 Bubblewrap 挂载下重复四轮通过；两个入口的 ephemeral 新建成功且 runtimeState 缺失，符合预期。模型切换覆盖使用模拟供应商，不冒称真实远端模型切换。

真实供应商：CODEX_RUNTIME_LIVE=1 使用独立临时 CODEX_HOME、工作目录和新 thread，仅要求回复 OK、不调用工具；未复用主力会话。2026-10-01 19:42–19:43（Asia/Shanghai）四轮全部成功，输出均为 OK，字段和原始 turn_context 的模型、effort、时间戳逐项一致：

| 入口 | 场景 | thread ID | turn ID | 模型 / effort | 原始观测时间 UTC |
| --- | --- | --- | --- | --- | --- |
| app-server | 新建继承 | 01a0f746-2227-77d1-b5fa-c52e4fd1c0e7 | 01a0f746-22ff-7572-b0ad-55f6d1373def | gpt-6-astra / medium | 2026-10-01T11:42:48.416Z |
| app-server | 续接覆盖 | 同上 | 01a0f746-40fd-7420-997b-4a3b4d47f71c | gpt-6-astra / low | 2026-10-01T11:42:54.933Z |
| exec JSON | 新建继承 | 01a0f746-5b16-76a2-a39e-a16295f5f650 | 01a0f746-5c60-7bb1-bdd0-bae7d1884341 | gpt-6-astra / medium | 2026-10-01T11:43:01.990Z |
| exec JSON | 续接覆盖 | 同上 | 01a0f746-7ce8-7751-867a-c8ef37eedc4d | gpt-6-astra / low | 2026-10-01T11:43:10.096Z |

真实检查会读取当时 rollout 作断言，临时 home 在测试结束后清理；摘要留在本表，另有临时 `/tmp/codex-runtime-live-report.json`。真实供应商检查未操作生产数据库；metadata/脚注链使用离线数据库替身验证，生产展示待 S06。

复现命令（相同前缀可替换其他 tests 文件）：

```sh
TS_NODE_BASEURL=. TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' node -r ts-node/register/transpile-only -r tsconfig-paths/register tests/codex-runtime-state.test.ts
CODEX_RUNTIME_NATIVE=1 CODEX_RUNTIME_BWRAP=1 TS_NODE_BASEURL=. TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' node -r ts-node/register/transpile-only -r tsconfig-paths/register tests/codex-runtime-state-native.test.ts
```

真实供应商检查将第二条命令的两个 CODEX_RUNTIME_* 开关替换为 CODEX_RUNTIME_LIVE=1；默认不运行 native/live 请求。

## 问题与未验收事项

- 首次 loopback fixture 未处理 CLI 的 GET 请求导致测试服务退出；已补 GET 404 分支，重跑通过。此问题仅在测试 fixture，不是生产 Codex 执行故障。
- CLI 报临时 home 不创建 PATH helper、现有 mcp-trymold SKILL.md 缺 YAML；loopback 另有未模拟 models endpoint 的 404。均不影响四轮断言，未扩大范围改外部技能或 CLI。
- 临时会话和无 rollout 路径继续未知是有意降级；没有从线程设置或请求参数兜底造值。
- 未部署、未重启、未验证网页和飞书生产卡片；下一步先做 S03 Pi，四类采集收口后再按 S06 安排房间验收。
- 保留原有无关工作区内容：config/runtime-environments.json、config/runtime-environments.hmi.lock、docs/inbox/482_ISSUE_20260928_服务监控Agent决策审计与历史保留策略研究.md、docs/gitnexus-wiki/、output/。仅追加 Git 提交，不改历史。

## 下一 Session（须用户手动启动）

```text
读取 AGENTS.md、docs/workflow/workflow-contract.yaml、docs/485_PLAN_20261001_LiveRoom四类Agent实际模型与思考状态遥测修复.md 和 docs/488_HANDOVER_20261001_LiveRoomCodex本轮模型与思考状态S02交接.md。只执行 PLAN 485 的 S03（Pi），复用 S01 executionId/runtimeState；先跑长文件守卫，核对 RPC / JSON / print 的本轮模型、原生思考状态和分支继承，不能用请求值或全局设置冒充。Codex S02 已完成并通过两入口新建/续接真实验证，不重启主力 Codex 或平台服务。不实施 S04–S06 或 PLAN 481，不改无关工作区，不自动外发消息。完成测试、真实验证、按合同生成并校验 HANDOVER，仅提交本 Slice 后停止。
```
