---
doc_type: HANDOVER
doc_status: paused
next_action: none
plan: docs/485_PLAN_20261001_LiveRoom四类Agent实际模型与思考状态遥测修复.md
slice: S01
plan_progress: in_progress
---


# HANDOVER · Live Room 四类 Agent 遥测计划与排查交接

## 当前状态：仅排查和规划，尚未实施

用户最后指令：“这轮先不要改，你就把计划列好，包括那个 Kimi code，我估计也有同样的问题。……交接文档和计划要写好。”本轮遵从该指令，**生产代码和测试零修改，四类实际值问题均未宣称修复**。PLAN 485 是 ready / await_approval 候选；本交接 paused / none，不触发 watcher 或下一 Session。不提审、不修改 watcher cursor、不重启服务、不推送远端。

frontmatter 的 slice: S01 只是下一实施入口，**S01 尚未开始，更没有完成**。生成器以 S01 生成继续模板后，已改为暂停 / none，删除自动下一 Slice Prompt，避免误启动 S02。plan_progress: in_progress 表示计划目标未完成。本轮仅完成文档准备。

新计划：`docs/485_PLAN_20261001_LiveRoom四类Agent实际模型与思考状态遥测修复.md`。它取代 HANDOVER 484 中仅面向 Codex/Pi 的待办范围；旧文档保留为历史记录，不能再据其把 Antigravity/Kimi 排除。PLAN 481 原生终端任务不在本轮或新计划范围内。

## 已确认的根因与入口

公共路径：`src/lib/harness/types.ts` → `src/lib/acpx/runner-harness.ts` → `participant.controlMetadata` → `src/lib/context-usage.ts` / `src/lib/live-room-footnotes.ts` / `src/lib/live-room-members.ts` → 网页消息和飞书卡片。

- `buildLiveRoomFootnotes` 第一行硬编码“思考强度：实际值未确认”；成员 `modelLabel` 同样硬编码。
- NormalizedContextUsage 只有可选 model，没有原生思考状态，且模型依赖 token 遥测校验。只改显示文案不能补全真实采集。
- `collectLiveRoomFootnotes` 从 participant metadata 生成快照。修复必须保留历史快照，不能用新成员设置改写旧回复。
- metadata 读写存在多路调用，实施时检查会话先落库和并发覆盖，不因增加一个字段丢掉原有 metadata。

| Agent | 已查文件/本机证据 | 下一步必须核实 |
| --- | --- | --- |
| Codex | `real-agents/codex-app-server.ts`、`codex-agent.ts`、`harness/adapters/codex.ts`；app-server 原生生成类型；已有 rollout 的 turn_context | 本轮 model/effort 与 turn_id 绑定；exec JSON / app-server / 新建 / 续接 / 临时会话 |
| Pi | `real-agents/pi-agent.ts`、`pi-rpc.ts`、`harness/adapters/pi-agent.ts`；本机 pi-mono RPC/session 源码 | RPC 状态与本轮绑定；JSON/print 正确 session 文件与分支；无全局配置兜底 |
| Antigravity | `real-agents/antigravity-agent.ts`、`antigravity-context.ts`、`harness/adapters/antigravity.ts`；一次真实短请求输出及同进程日志 | stream-json 无模型字段时的可信替代；日志选型是否对应本轮实际运行；续接/覆盖/回退 |
| Kimi Code | `harness/adapters/kimi-code.ts`、`real-agents/kimi-code-context.ts`、`kimi-code-telemetry.ts` | wire 模型/思考原生字段，旧记录时间问题，模型与 token/配置窗口解耦 |

### Codex：线程配置与轮次证据不能混用

在当前本机运行 `codex app-server generate-ts --out /tmp/ap-codex-protocol` 获取类型：

- `v2/ThreadStartResponse.ts` / `ThreadResumeResponse.ts` 顶层有 model、modelProvider、reasoningEffort。
- `v2/TurnStartResponse.ts` 仅返回 turn；不能假定它一定回传模型。
- `v2/Thread.ts` 对 model/reasoningEffort 明确注明：当前配置或最后持久化设置，不是 per-turn execution telemetry。
- 本机旧记录 `/home/hello/.codex/sessions/2026/09/24/rollout-2026-09-24T17-27-54-01a0d2be-3110-7d62-bf7b-1dfd49cddc8a.jsonl` 中有 `turn_context`：model=`gpt-6-astra`、effort=`medium`、turn_id=`01a0d2be-c42e-7be3-81e5-aa4c4bd8c14e`、timestamp=`2026-09-24T09:28:33.765Z`。这只证明格式，不是当前房间/本轮的值，禁止硬编码。
- app-server 的 turn/start 请求可以覆盖 model/effort；只接 thread 回执可能仍错。优先核实当前执行的 turn_context 或其他逐轮原生证据。注意 CODEX_HOME 隔离目录与 ephemeral 无文件情形。

### Pi：已有可信采集入口，尚未接到平台

已读本机源码 `/data1/code/pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts` 的 get_state：返回 session.model、thinkingLevel、sessionId、sessionFile。`core/session-manager.ts` 定义 model_change、thinking_level_change、parentId；有效状态需要遵循分支，不取全文件最后出现的值。

`modes/print-mode.ts` 的 JSON 输出包含 session header 和事件；print 文本路径不保证输出状态，需从本次实际使用的会话文件取证。平台当前仅有 onSteeringReady 才走 RPC，其余 JSON，失败可能退到 print。修复不能只覆盖一个入口。用户先前提供的 zai / glm-5.3 / high 尚未经本轮真实独立验证，不能当固定默认。

### Antigravity：本轮已做的一次短请求及局限

用户追加“先不要改”之前，启动并完成一个独立诊断请求：`agy -p 'Reply only OK. Do not use tools.' --new-project --output-format stream-json --print-timeout=60s`。返回 `OK`、status=SUCCESS；创建独立项目/会话，没有向飞书发送消息，未改仓库代码。

- conversation_id：`28899c65-d8dc-4c8e-845d-d5346bf5d518`。
- 项目 ID：`77cd89df-fef8-44f2-9964-2b3003aae7e9`。
- `/tmp/ap-agy-telemetry.jsonl`：init、step_update、result；result usage input=15494、output=35、thinking=34。**无 model/effort 字段**；不能从 thinking_tokens 推断强度。
- `/tmp/ap-agy-telemetry.err`：本次无 stderr 内容。
- `/home/hello/.gemini/antigravity-cli/log/cli-20261001_184745.log`：该进程多次记录 `Propagating selected model override to backend: label="Gemini 3.8 Flash (High)"`，随后创建并发送到上述 conversation。
- 日志说明运行器选型，不直接证明供应商实际执行模型及 thinking 档位；需检验续接/显式覆盖/回退。**不能仅把括号 High 改写成 high 即宣布修复**。
- CLI help 确认支持 `--log-file`、`--model`、`--effort`。若采用日志，应为每次执行指定专属路径并绑定 conversation，不能共享读取全局最新日志。限制模式的 `/tmp` 是 Bubblewrap 独立 tmpfs，路径可见性须验证，不能靠放宽权限解决。

以上临时文件可能被清理，核心事实已写入本文；不要将完整日志或会话正文提交到仓库。本轮未做 Antigravity 续接、覆盖或展示端到端验收。

### Kimi Code：不能忽略现有遥测中的证据问题

- `parseKimiCodeContextUsage` 从 wire `config.update.modelAlias` 读取 alias，存在一定真实来源，不能一概说模型全部硬编码。但 modelAlias 不一定是供应商最终模型 ID，需说明语义。
- 没有思考状态采集/归一化；要查真实版本支持的是开关、档位还是没有对应能力。
- `collectKimiCodeProviderContextUsage` 同时要求 wire token、protocolVersion、config.toml 中 contextWindow，任一缺失就连模型一起丢弃。
- 它读取整个 wire 后以当前 collectedAt 写结果，未限定本轮新增数据，旧值可能被重新赋予新时间。
- adapter 把配置窗口标为 measured_exact；需要回到证据来源而非延续错误百分比置信度。
- 本轮仅源码核查 Kimi，未启动真实 Kimi 请求，不宣称已确认 thinking 字段或已完成验收。

## 新 Session 的执行顺序

严格按 PLAN 485：S01 公共链路 → S02 Codex → S03 Pi → S04 Antigravity → S05 Kimi → S06 四类验收。各 Slice 自带测试、边界、停止条件；默认一 Session 一 Slice，提交交接后停止。当前四类缺陷仍在，S01 公共通路通过也不代表全部修复。

新 Session 从 **S01** 开始；不要沿用生成器最初的 S02 自动继续内容。实际字段不依赖 token；保留原生思考语义、来源/会话/轮次、未知和不适用的区别。没有 provider 证据时只显示运行器确认的层级，不声称供应商内部最终路由。

## 本轮验证与未做事项

- 开工已跑 `npm run check:long-files`：通过，无文件达到 1000 行。
- GitNexus 查询公共新符号未命中；对 `runCodexAppServer` 用明确 UID 做 upstream 影响检查，结果 LOW，直接调用是 executeCodexCLI / resumeCodexSession，间接为 executeCodexTask。查询仅为辅助，源码已核实；不凭索引认定全链覆盖。
- Antigravity 诊断子进程已完成并回收，exit=0，没有需继续等待的已知探针。
- 仅文档变更，不运行无关生产测试/构建，不声称 TypeScript/四类真实验收已通过；两份文档暂存后 preflight 均通过（PLAN action=await_approval，HANDOVER action=none），`git diff --cached --check` 通过。
- 没有修代码、部署、重启、推送、外发飞书、启用 watcher、提审或启动新 Agent/Session。

## 提交范围与现存无关工作区内容

本轮仅新增 PLAN 485 与 HANDOVER 486，按文档规范 PLAN 独立提交，交接另提交，Git 历史只追加。

以下进入本轮时已存在，保持原状，禁止 `git add .` 混入：

- `config/runtime-environments.json`
- `config/runtime-environments.hmi.lock`
- `docs/inbox/482_ISSUE_20260928_服务监控Agent决策审计与历史保留策略研究.md`
- `docs/gitnexus-wiki/`
- `output/`

基线 HEAD：`0726110 feat(live-room): add reply footnotes and member model settings with telemetry handover`。旧 HANDOVER 483/484 是背景，不是四类已修证明。

## 手动开启新 Session

本交接为 none，不带自动化 Prompt 标记、不发 WORKFLOW_READY。PLAN 485 中的 Prompt 是供用户手动启动 S01 的明确指令，最终回复将原样重复；复制它开启新 Session 即可。当前会话不执行该 Prompt。
