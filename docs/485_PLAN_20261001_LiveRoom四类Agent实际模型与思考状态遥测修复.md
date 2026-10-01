---
doc_type: PLAN
doc_status: ready
next_action: await_approval
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---


# PLAN · Live Room 四类 Agent 实际模型与思考状态遥测修复

## 1. 总体目标与当前授权

让用户在 Codex、pi-agent、Antigravity、Kimi Code 的每轮回复脚注和成员面板中，看见有本轮证据的模型与思考状态，并能区分实际运行状态、请求设置和缺失数据。

2026-10-01 用户明确要求“这轮先不要改，把计划和交接写好，新开 Session 来做”，并追加 Kimi Code。因此本轮仅规划，所有 Slice 均未执行。本文为独立 phase PLAN（包含可按 Session 执行的 Slice），ready / await_approval 只保存候选，不提交审批、不启动执行。不要启动 PLAN 481 原生终端任务，也不要把本计划挂到其 S07。

## 2. 当前障碍：已确认与待核实分开

- 公共层：`src/lib/live-room-footnotes.ts` 与 `src/lib/live-room-members.ts` 把思考强度写死为未确认；`NormalizedContextUsage` 没有 reasoning 字段。实际模型依赖 token 遥测存在且有效，模型状态可能被 token 缺失连带丢弃。
- Codex：adapter 只从 token 回调提取输入、输出和窗口，没有提取模型/强度。本机生成的 app-server 协议表明 thread/start、thread/resume 顶层返回 model、modelProvider、reasoningEffort；Thread 类型明确注明其模型/强度是线程配置，**不是逐轮执行遥测**。turn/start 还可能覆盖设置，不能把旧线程回执当本轮实际值。本机已有 rollout 的 turn_context 包含 model、effort、turn_id、timestamp，是优先核实的轮次证据。尚未完成新建/续接实测。
- Pi：adapter 没有归一化模型/思考状态回传。已读本机 pi-mono 源码：RPC get_state 返回 session.model、thinkingLevel、sessionId、sessionFile；会话文件含 model_change、thinking_level_change 和 assistant message。需按实际分支、当前轮及模型切换取值，不能单取全局 settings 或最后修改的目录。JSON/print 与 RPC 是不同入口，均需覆盖。
- Antigravity：本轮真实短请求的 stream-json 返回 init、step_update、result 和 token，但没有 model/effort。因此原有“从 JSON 取 model”不足。该进程日志有 `Propagating selected model override to backend: label="Gemini 3.8 Flash (High)"`。这是运行器选型线索，**尚非已验证的供应商实际执行回执**；是否准确覆盖续接、effort 覆盖和模型回退待查。不能仅按标签括号拆出 high 就宣称闭环。
- Kimi Code：adapter 已从 wire 的 config.update.modelAlias 回传 model，但没有思考状态；collectKimiCodeProviderContextUsage 依赖 token、protocolVersion 和配置文件窗口，缺一即返回 null；对旧 wire 全量读取后使用当前时间 collectedAt，可能让旧数据看似本轮新数据。contextWindow 来自配置，却标记 measured_exact，也需纠正证据口径。当前未验证 Kimi 本机协议是否返回 thinking 开关/档位，不能预先断言不支持。

旧 HANDOVER 484 仅将 Codex/Pi 列为下一阶段，范围不完整。本文和新 HANDOVER 将待办扩为四类 Agent；不回写旧消息快照，不改写历史提交。

## 3. 总体路线与本 PLAN 结果

| 阶段 | 解决的问题 | 可验证结果 | 本 PLAN |
| --- | --- | --- | --- |
| 公共链路 | 模型依附 token、强度写死、请求与实际混淆 | 独立运行状态可入库并到达两个展示入口 | S01 |
| 四类采集 | 各运行器没有提供本轮可信值 | 每类分别完成协议采集、新建/续接与展示验证 | S02–S05 |
| 整体验收 | 局部模拟通过无法证明房间实际效果 | 新回复、成员面板、网页/飞书值与原始证据一致 | S06 |
| 原生终端和远端新协议 | 与本故障无直接依赖 | 留在原计划处理 | 否 |

全部完成后，四类 Agent 的已确认值不再永久显示占位符；缺失字段准确降级，不填假值。思考状态保留原生语义：等级、开关、运行器明确表示不适用、或未知；不能把 Kimi 的开关强映射成 Codex high，也不能把未返回字段当作关闭或不支持。

实际运行值指与本次执行绑定、底层运行器确认的状态；若仅获得运行器状态而不是供应商回执，展示/诊断注明证据层级，不声称证明远端服务内部最终路由。实际模型名称与请求 alias 可并存，不能悄悄把 alias 升格为供应商模型 ID。

## 4. 共同数据与展示约束

复用 `Harness → acpx/runner-harness.ts → participant.controlMetadata → footnotes / members → 网页及飞书`。优先在现有 metadata 增加独立运行状态，不做数据库迁移、不新建通用事件总线。类型名称和字段以实施时最小可行设计为准，必须承载：模型/provider、原生思考状态、来源、session、轮次或本次执行关联、观测时间；未知和不适用有明确区别。

- token 缺失不能丢掉已有模型证据；模型状态存在也不能捏造 token=0 或上下文窗口。
- 事件观测时间与读取时间分开；读取旧文件不刷新证据年龄。续接需证明本轮沿用了该状态，而非仅因 session 相同就接受旧记录。
- 不同成员/会话不串值；新建、重置、失败、重试、超时及中途切换模型时，不泄漏上一轮值。落库先绑定会话，回调与最终结果不能覆盖较新记录或丢失同 metadata 中其他字段。
- 请求 model/reasoning 保留为单独请求信息；不从成员设置、全局默认、命令参数或 Agent 自述填充“实际值”。
- 本轮脚注保存历史快照；成员面板注明最近观测及来源。长时间运行的最终快照不能单因起始模型状态超过现有 15 分钟 token TTL 就丢掉，须用执行关联判断，并保留过期/跨会话拒绝测试。
- 遥测不可用不能令任务执行失败；错误应可诊断。对原始日志/记录做字段校验，不把工具输出/回答正文当协议证据；只保存必要字段，不持久化敏感原始输出。

## S01：打通不依赖 token 的运行状态与公共展示

- **目的**：消除四类 Agent 共用的“强度写死”和模型随 token 一起丢失的根因。
- **完成后结果**：带 session/轮次证据的模型与思考状态能持久化，并进入脚注和成员标签；未知、开关、不适用准确区分。四类采集尚未接入时明确保持未知，不宣称修复完成。
- **实现方法**：在 harness 类型/结果和既有 metadata 持久化路径增加最小运行状态通路，独立于 NormalizedContextUsage；共享读取校验和格式化；替换两个展示点的硬编码，复用现有脚注快照与 relay。优先结果回传；需要流式状态时复用 callback，不另建基础设施。
- **修改边界**：`src/lib/harness/types.ts`、`src/lib/acpx/runner-harness.ts`、必要的独立运行状态小模块、`src/lib/live-room-footnotes.ts`、`src/lib/live-room-members.ts`；必要时 `src/lib/acpx/types.ts`。直接测试参考 normalized-context-usage、live-room-footnotes、harness-context-usage。文件数超过默认预警，因为类型、写入、读取和两个消费入口构成一个原子协议；不夹带各 provider 实现、UI 重设计或权限变更。
- **验收**：从 harness 回执/回调经过持久化到脚注和成员标签的可运行测试；不能只给 formatter 人工传 model。覆盖无 token、请求与实际不同、session 不匹配、旧轮、超时/失败、长轮次、非法类型和快照不变。现有上下文口径测试通过。
- **前置与停止条件**：先复读 AGENTS、合同和本文，跑长文件守卫；对共享符号做 GitNexus 影响检查并用源码核实。若设计需要重做数据库或 UI，停下重划边界。
- **交付物**：独立代码/测试提交与 HANDOVER，说明公共通路完成、provider 仍待接入，提交后停止。

## S02：Codex 本轮模型与强度回传

- **目的**：把实际运行证据接入 S01，而非复制 turn/start 请求值。
- **完成后结果**：Codex 新建及续接回复显示当前轮有来源的模型/强度，明确未知降级。
- **实现方法**：核对本机 app-server 协议与实际 rollout；优先 turn_context 的 model/effort/turn_id。区分 thread/start、thread/resume 回执与 turn/start 覆盖，若用运行器确认状态须证明本轮未被覆盖/回退。覆盖 app-server 和 exec JSON 两入口，尊重实际 CODEX_HOME、临时会话与隔离挂载。不要扫描全机后挑“最近一份”文件。
- **修改边界**：`src/lib/real-agents/codex-app-server.ts`、`codex-agent.ts`、必要的专用解析小模块、`src/lib/harness/adapters/codex.ts` 与直接测试；文件数略多是两个既有传输共享一个 adapter，不改变权限、steering 和 fallback 决策。
- **验收**：实际协议 fixture 到 metadata/脚注的测试，覆盖继承、显式覆盖、续接改设置、无 rollout、非本轮事件及模型变更。至少一次真实新建与续接，比较原始证据和输出，不将模拟通过写成真实通过。
- **前置与停止条件**：S01 已完成；拿不到当前轮证据时保留未知并记录具体限制，不用线程旧值兜底冒充，不扩大为 CLI 升级。
- **交付物**：Codex 独立提交、测试与真实验证摘要、HANDOVER，提交后停止。

## S03：Pi 的 RPC / JSON / print 状态回传

- **目的**：补齐 Pi 完全缺失的运行状态通路，处理继承和恢复。
- **完成后结果**：模型以运行记录的 provider/model 表示，思考状态保留 Pi 原生 off/minimal/low/medium/high/xhigh 等返回值，不推断 provider 内部映射。
- **实现方法**：RPC 从与当前进程及 session 绑定的 get_state/事件取值；JSON/print 从当前执行使用的 session 记录或已确认协议采集。按 parentId 分支追溯有效 model_change/thinking_level_change，并用本轮 assistant/执行关联确认有效；处理中途切换，不遍历其他 session 猜值。确保 session 持久化 await，不与采集竞态。
- **修改边界**：`src/lib/real-agents/pi-rpc.ts`、`pi-agent.ts`、`src/lib/harness/adapters/pi-agent.ts`，必要的解析小模块和对应测试。覆盖三种传输所需改动一起收口，不修改 pi-mono 或加入新的 RPC 功能。
- **验收**：三入口新建/恢复参数路径及实际状态测试，包含请求与回执不同、继承、分支切换、off、无 thinking 记录、断流。真实新建/续接证据至少一组；其余入口若只有模拟测试需逐项说明，不冒称全部真机验收。
- **前置与停止条件**：S01 完成；不依据环境和全局 settings 补假值，不将 Pi 档位与 provider 映射混为一谈。
- **交付物**：Pi 独立提交、证据摘要、HANDOVER，提交后停止。

## S04：Antigravity 找到并接入可核实的运行状态

- **目的**：解决 stream-json 没有模型字段而永远未知的问题。
- **完成后结果**：已证实的模型/思考状态可展示，来源和证据不足明确可见。
- **实现方法**：先验证当前 CLI 的原生回执/会话记录；若必须用日志，使用 `--log-file` 的本执行专属文件，绑定进程与 conversation，检查新建/续接/--effort/--model 的实际行为。已发现 selected model override 标签仅是线索，确认是本轮生效状态后方可采用，并区分“运行器报告”与“供应商确认”；不要读共享最新日志或盲拆标签。兼容 Bubblewrap 的挂载/临时目录，不放宽权限，不把正文推断当遥测。
- **修改边界**：`src/lib/real-agents/antigravity-agent.ts`、`antigravity-context.ts`（或独立运行状态解析文件）、`src/lib/harness/adapters/antigravity.ts` 和对应测试；不升级 agy、不改外部二进制。
- **验收**：基于真实脱敏事件/日志 fixture 测解析和 adapter 到展示；真实新建+续接，继承和可用的显式覆盖；并发日志隔离、结果无 token、失败和日志缺失不串值。必须证明标签/effort 与本轮的关系。
- **前置与停止条件**：S01 完成；如果协议没有足够证据，记录具体 CLI 版本/可见字段/缺口并将此 Slice 标为未闭环，不凭参数造值、不宣告四类全修。
- **交付物**：Antigravity 独立提交或确切阻塞交接、证据摘要、HANDOVER，提交后停止。

## S05：Kimi Code 模型、思考语义与 wire 新鲜度

- **目的**：避免遗漏第四类 Agent，并修复模型读取耦合和旧 wire 被重新打时间的问题。
- **完成后结果**：Kimi 模型不因无 token/窗口而丢失；思考能力按真实协议显示；旧记录不会冒充新一轮值，配置窗口不会冒充精确测量。
- **实现方法**：核实当前 CLI wire/session 中模型 ID、modelAlias、thinking 开关/档位的原生字段；从本轮新增事件或可靠轮次边界确认，续接继承必须有执行证据。拆开运行状态和 token 读取，记录源时间/执行关联，停止用读取时刻为旧记录续命；窗口来源保留配置/估计标识。不依据模型名猜 thinking 支持，也不为了显示强度先加设置项。
- **修改边界**：`src/lib/real-agents/kimi-code-context.ts`、`kimi-code-telemetry.ts`、`src/lib/harness/adapters/kimi-code.ts`，必要时 `kimi-code-agent.ts` 获取本轮 wire 边界，与直接测试。已有解析/采集/adapter 分层共同构成此次原子修复；不改账户配额模块行为。
- **验收**：wire fixture 到状态/脚注/成员标签；无 token、有模型无配置窗口、损坏行、旧文件不增长、续接改模型、开关/等级/未知、不适用及配置窗口置信度。真实新建和续接比对，确认适配器不会仅因配置读取失败丢模型。
- **前置与停止条件**：S01 完成；若无法获得 thinking 语义证据，明确未知并交接，不把“不返回”写成“不支持”，不扩大到 CLI 功能开发。
- **交付物**：Kimi 独立提交、真实证据摘要、HANDOVER，提交后停止。

## S06：四类 Agent 的房间验收与交付

- **目的**：证明真实运行值经过整条链路后仍正确，不把单元测试当作线上效果。
- **完成后结果**：四类各有一份“原始证据 → metadata → 保存的脚注 → 成员标签 → 网页/飞书卡片”的对照结论，历史回复保持原样。
- **实现方法**：复用前面已建测试和真实验证记录，在隔离测试任务/房间验证新回复；检查普通回复和 workflow/plan 路径共同调用 footnote，检查 Feishu 最终卡片及 relay 一致。加载服务新代码前检查活动任务，不能重启杀掉当前会话。真实外发消息需用户授权；当前只授权文档，不发送测试消息。
- **修改边界**：已有直接集成测试及验收/HANDOVER 文档；若发现某 provider 缺陷，返回其 Slice 修复并追加提交，不把全部生产改动塞进本步。
- **验收**：`npm run check:long-files`、`npx tsc --noEmit`、`git diff --check`，受影响测试；继承、覆盖、续接、重置、跨会话、缺字段、长轮次和历史快照矩阵全覆盖。外部服务/权限阻塞须逐项列为未验收。
- **前置与停止条件**：S02–S05 全部闭环；任一仍靠占位符而底层可采集的路径未修，不能标记全部完成。无需为凑四个相同档位而伪造不支持的语义。
- **交付物**：验收记录、独立提交与终态 HANDOVER；未完成项明确保持未完成，提交后停止。

## 5. 验收矩阵与退出边界

| 场景 | 四类均需证明的行为 |
| --- | --- |
| 继承默认 | 由底层本轮证据确认，不从默认配置推测 |
| 显式覆盖/续接改设置 | 显示真正生效状态，请求与实际可不同 |
| 未返回模型/强度 | 分字段未知；已知另一字段继续可见 |
| 无档位/只支持开关 | 有协议依据才显示不适用或开/关，不映射假等级 |
| 无 token/窗口 | 不丢模型，不生成假百分比 |
| 旧轮/旧文件/其他成员 | 不串值、不刷新源时间 |
| 历史回复 | 保存时快照，后续配置不改旧消息 |
| 中断/错误/回退 | 不显示旧成功轮的值，记录证据范围 |

不处理 PLAN 481、不重做模型设置 UI、不修改 DB schema、不引入依赖、不改远端 runner 协议、不部署或对外发消息。当前已确认范围为 Platform Local 四类；其他后端不得复用本机 session 文件或冒称已有覆盖。每步先验证再提交，只追加 Git 历史。

## 下一 Session Prompt

<!-- WORKFLOW_PROMPT_START -->
读取 `AGENTS.md`、`docs/workflow/workflow-contract.yaml`、`docs/485_PLAN_20261001_LiveRoom四类Agent实际模型与思考状态遥测修复.md` 和本任务最新 HANDOVER（本轮为 486 号交接）。按本次手动启动指令只执行 PLAN 485 的 S01；四类范围是 Codex、pi-agent、Antigravity、Kimi Code。先跑长文件守卫，打通不依赖 token 的本轮实际模型/思考状态持久化和公共展示，不用请求值或全局默认冒充实际值。保留会话/轮次绑定、来源、原生思考语义、未知降级及历史快照。本 Session 不实施 S02–S06，不启动 PLAN 481，不改无关工作区内容，不自动发送飞书消息或重启服务。完成测试、按合同生成并校验 HANDOVER、仅提交本 Slice 文件后停止。
<!-- WORKFLOW_PROMPT_END -->
