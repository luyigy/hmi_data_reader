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

# PLAN · Antigravity 与 Kimi 真实上下文水位及账户 Quota

## 目标

为 Platform Local Antigravity 与 Kimi Code 建立可验证的 provider 真实信号，停止用 Room 消息数、
事件数或 transcript 字符数冒充模型上下文占用，并把账户调用额度严格限制在管理员诊断边界。

本计划复用 Codex S09 已有的 freshness、Session 匹配、乱序保护、`controlMetadata`、Live Room
序列化和管理员 quota 命令模式；不新增数据库表、通用事件总线或第二套执行框架。

## 已确认事实

- `docs/307_HANDOVER_20260729_CodexProvider遥测与Quota诊断S09交接.md` 已将 Codex 的
  thread context usage 与 account rate limit 分离：
  - thread usage 可驱动 Session 水位；
  - account quota 仅供管理员诊断，不进入普通 Room payload。
- 当前 `src/lib/live-room-members.ts` 在缺少 Codex provider usage 时，仍以消息数、事件数和
  transcript 字符数计算 `estimated` 百分比；该值不是真实模型上下文占用。
- 开工前工作区已有用户未提交的 `src/lib/acpx/prompt.ts`、
  `src/lib/acpx/runner-participant.ts`、`src/lib/live-room-members.ts`、
  `tests/context-watermark-warning.test.ts` 等修改，已经部分收紧缺少 provider telemetry 时的提示语。
  这些改动必须先辨认并保护，不得覆盖或夹带。
- 本机 Antigravity CLI 为 `1.1.8`：
  - `agy -p` 支持 `--output-format json|stream-json`；
  - `stream-json` 提供 `init`、`step_update`、`result` 和 usage；
  - 当前 Platform 仍使用纯文本 stdout；
  - 当前 Antigravity Adapter 不支持 continuation，每次 turn 都是新的 CLI conversation。
- 本机 Kimi Code 为 `0.30.0`：
  - 当前 Platform 使用 `--prompt --output-format stream-json` 并支持同 Session continuation；
  - print-mode `stream-json` 不输出 `contextTokens`、`maxContextTokens` 或 `contextUsage`；
  - Kimi 官方运行时提供 `Session.getStatus()` / `Session.getUsage()`；
  - Session `wire.jsonl` 会持久化按模型的 `usage.record`，配置中包含模型
    `max_context_size`，但二者是否能准确重建官方 context usage 必须先实测证明。
- Kimi Code 官方账户 usage 入口为 managed platform `/usages`，包含 used、limit、reset 和多个
  quota window；它属于账户额度，不属于 Session context。
- Antigravity CLI 的 `/usage`、`/quota` 会刷新真实额度，但 headless quota 的稳定机器协议尚未确认；
  不得抓取 TUI 文本或在未验证时直接依赖逆向字段。
- `npm run check:long-files` 当前通过，没有达到 1000 行阻断阈值的源码。

## 语义合同

### 1. Session context 与 account quota 分离

| 信号 | 用途 | 是否触发 `/ap new-session` |
| --- | --- | --- |
| Session context usage | 当前 conversation 是否接近模型上下文窗口 | 是 |
| Account quota | 当前认证账户是否还能继续调用 provider | 否，仅管理员诊断 |
| 消息数、事件数、transcript 字符数 | Platform 代理健康信号 | 否，不生成真实占用百分比 |

### 2. 水位状态

- `provider`：存在新鲜、Session 匹配、字段有效且语义已验证的 provider context usage。
- `unknown`：provider 未提供、数据过期、Session 不匹配、乱序或协议无法验证。
- `not_applicable`：当前 Harness 不复用跨 turn conversation；Antigravity 在 continuation 接入前属于
  此状态。
- 只有 `provider` 可以生成真实百分比并按 60% / 85% 提示。
- `unknown` 和 `not_applicable` 不得用消息数、事件数或字符数补成百分比，不得生成“立即换 Session”
  的强提醒。
- 代理健康信号可继续显示原始计数或弱诊断文字，但必须与 context usage 分栏，不能使用 quota、
  remaining context 或真实水位措辞。

### 3. 账户 quota 安全边界

- 仅配置的 Feishu 管理员可请求。
- 仅查询当前 Room 中选定的 Platform Local provider 成员。
- 按有效 provider home / 认证账户目录隔离短时缓存。
- 普通 Room/API payload、participant metadata 和数据库不得包含账户 quota、账户标识、凭证或原始
  provider 响应。
- 对外只返回清洗后的窗口名称、used/limit 或 used percent、reset 时间、采集时间和
  `available|unknown` 状态。
- quota 获取失败不改变 turn 成败，也不触发 Session reset。

## 范围

### 包含

- Antigravity 1.1.8 `stream-json` 协议与 usage 语义取证；
- Kimi 0.30.0 Session context 真实值取证与最小读取路径；
- provider context metadata 的 freshness、Session 匹配、乱序和降级语义；
- Live Room Web、飞书成员状态和 ACPX prompt warning 的一致水位规则；
- Kimi managed `/usages` 管理员 quota；
- Antigravity headless quota 在协议通过门禁后的管理员诊断；
- 聚焦 fixture、权限隔离、Session reset、compaction 和既有 Harness 回归。

### 不包含

- 不为 Antigravity 增加 conversation continuation；
- 不把 Antigravity 单次 run 累计 token 当作跨 turn Session 水位；
- 不接 Kimi Web UI，不整体迁移到 Kimi ACP/SDK 执行框架；
- 不为 Claude、DeepSeek、Gemini、Pi 或 remote SSH 补 provider telemetry；
- 不新增 Prisma migration、账户表、通用 Provider 抽象或事件总线；
- 不抓取或解析 TUI 彩色文本；
- 不修改 handoff、delivery、预算、锁、顺序、审批或失败重试语义；
- 未经用户另行明确授权，不调用真实模型、重启服务、发送真实 Feishu 消息或修改生产数据。

## S01：协议取证、fixture 与停止门禁

只建立可信输入和最小 parser，不接共享水位或管理员命令。

1. 读取目标 HEAD 的 workflow contract、本 PLAN、307/312/315 及开工前工作区状态；保护
   `docs/DRAFT_20260730_quota.md` 和所有用户未提交改动。
2. 对本 Slice 将修改的每个 function/class/method 先运行 GitNexus upstream impact；
   HIGH/CRITICAL 先报告再编辑。
3. 在用户明确授权一次真实 provider 调用后，捕获并脱敏：
   - Antigravity 1.1.8 首轮及多 step `stream-json`；
   - Kimi 0.30.0 首轮、resume、自动 compaction 前后官方 status 与 Session wire 对照。
4. Antigravity fixture 必须确认：
   - terminal/result 事件、conversation 标识和 usage 字段；
   - usage 是最后一次 provider request、每 step 还是整次 run 累计；
   - input/cache-read 是否重叠；
   - 可验证的模型 context window 来源。
5. Kimi fixture 必须确认：
   - 最新 `usage.record` 与 `Session.getStatus().contextTokens` 的关系；
   - cache read、工具循环、resume 和 compaction 后的计算是否仍准确；
   - model alias 与 `max_context_size` 的稳定映射。
6. 为通过验证的协议创建最小 parser 和 fixture 测试；未知字段忽略，缺少关键字段 fail closed。

停止门禁：

- 若 Antigravity usage 只是整次 run 累计或没有可信 context window，则不得把它接入 context
  percentage；记录为 run usage，并保持 `not_applicable`。
- 若 Kimi wire 不能与官方 `getStatus()` 在首轮、resume、工具循环和 compaction 场景一致，则停止
  wire 方案，不编写估算公式；创建决策说明并等待用户批准是否扩大到 ACP/SDK。
- 若 Antigravity headless quota 需要解析 TUI、复制长期凭证或依赖未验证的账户字段，则本计划不实现
  Antigravity account quota，返回 `unknown`。

完成标准：

- 脱敏 fixture 不含 prompt、文件内容、账户标识、Token 或路径隐私；
- parser 测试覆盖分片 NDJSON、未知事件、缺字段、乱序、累计值误用防护和版本差异；
- 实际运行过的聚焦测试、相关 ESLint、`npx tsc --noEmit`、`npm run check:long-files` 和
  `git diff --check` 通过；
- 运行 GitNexus `detect_changes`，只提交 S01 parser/fixture、测试和 S01 HANDOVER；
- 未通过的 provider 按停止门禁结束，不自动进入 S02 对应实现。

## S02：真实水位与告警语义

复用通过 S01 的 provider 数据，把房间水位从估算百分比改为显式真实/未知/不适用状态。

1. 先对实际修改的共享 symbol 运行 GitNexus upstream impact；HIGH/CRITICAL 先报告。
2. 在既有 `controlMetadata` 中只保存清洗后的最新 context snapshot：
   provider、Session/conversation id、collectedAt、used tokens、context window 和来源版本；
   不保存原始事件或账户 quota。
3. Kimi 仅在 S01 wire 门禁通过时，于成功 turn 后读取匹配 Session 的最新 usage，处理：
   - 同 Session 单调性；
   - `/ap new-session` 后旧 Session 隔离；
   - resume、invalid-session fresh fallback；
   - compaction 后允许真实水位下降；
   - timeout、stop、失败 turn 不覆盖最后成功 snapshot。
4. Antigravity 在没有 continuation 时固定为 `not_applicable`：
   - structured usage 可用于单次 run 诊断；
   - 不持久化为跨 turn context percentage；
   - 不根据 Room 累计消息数要求 `/ap new-session`。
5. 收敛 Live Room serializer 与 ACPX prompt warning：
   - `provider` 才显示 percentage、used tokens/context window 和 60%/85% 建议；
   - `unknown` 显示“暂无 provider 上下文遥测”；
   - `not_applicable` 显示“每轮新 conversation”；
   - 原始 message/event/transcript 指标保留为独立的 Platform 信号，不再参与 percentage 或强提醒。
6. Web 与飞书继续复用同一 member serializer，不在各入口复制 provider 判断。

完成标准：

- Kimi 首轮、resume、compaction、new-session、乱序、过期和失败降级测试通过；
- Antigravity 无 continuation 时不再产生累计 Session warning；
- Codex provider 水位行为不回归，过期/Session 不匹配仍降级为 `unknown`，不恢复 estimated 百分比；
- Web、飞书和 prompt warning 对同一成员的 source、percentage 和 recommended action 一致；
- 普通 payload 只含 context snapshot，不含账户 quota 或凭证；
- 聚焦测试、相关 Harness/Live Room 回归、TypeScript、ESLint、long-file guard、
  `git diff --check` 和 GitNexus `detect_changes` 通过；
- 只提交 S02 相关文件与 S02 HANDOVER。

## S03：管理员账户 Quota 与综合验收

1. 对 quota parser、缓存、管理员命令和共享 selector 的修改先运行 upstream impact；
   HIGH/CRITICAL 先报告。
2. Kimi quota：
   - 复用 Kimi managed platform `/usages` 的已验证 payload；
   - 只使用当前 Kimi 认证边界，短时缓存，超时和非 managed provider 返回 `unknown`；
   - 输出 weekly/窗口 used、limit、reset 与采集时间，extra usage 仅在不泄露付款或账户信息时展示。
3. Antigravity quota：
   - 只在 S01 已证明稳定的机器协议、认证刷新和字段含义后实现；
   - 按 Antigravity auth home 隔离缓存；
   - 协议不稳定或权限不足时返回 `unknown`，不回退 TUI scraping。
4. 扩展现有管理员 `/ap status --quota`：
   - 非管理员在数据库和 provider 查询前拒绝；
   - 仅支持当前 Room 选中的 Platform Local Codex、Kimi 或已通过门禁的 Antigravity；
   - quota 失败不影响普通 `/ap status` 和 Agent turn。
5. 综合验证：
   - Codex、Kimi、Antigravity 的 context 与 account quota 不互相驱动；
   - provider 缺失、过期、账号切换、并发查询和 reset 时间更新；
   - 普通 Room/API/metadata 无 quota；
   - Kimi continuation、Antigravity fresh-per-turn、Codex thread continuation 无回归；
   - safe workspace、stop、timeout、invalid continuation 和 handoff/delivery 既有语义无回归。

完成标准：

- 管理员权限、账户隔离、缓存过期、稀疏/乱序更新和敏感字段隔离测试通过；
- 真实 quota smoke 仅在用户再次授权后执行，且不发送 Feishu 消息或修改生产数据；
- `npx tsc --noEmit`、相关 ESLint、全部聚焦测试、`npm run check:long-files`、
  `git diff --check` 和 GitNexus `detect_changes({scope: "compare", base_ref: "master"})` 通过；
- 创建 `plan_progress: complete`、`next_action: await_acceptance` 的 S03 终态 HANDOVER 后停止。

## 风险与控制

- **共享水位类型：** `LiveRoomMemberContextWatermarkPayload`、serializer 和 prompt warning 有 Web、
  Feishu、runner 多个消费者；任何修改前必须完成 GitNexus impact，HIGH/CRITICAL 先报告。
- **协议语义误判：** 累计 billing usage 不等于当前 context occupancy；没有真实 fixture 和 denominator
  不生成 percentage。
- **Kimi 内部格式：** Session wire 是本地、版本相关协议；只有与官方 status 对照通过才使用，版本变化
  或字段缺失时 fail closed。
- **Antigravity fresh-per-turn：** continuation 未接入前，不为“未来可能续聊”预建累计状态。
- **凭证与隐私：** quota 获取只能在 provider 认证边界内进行；不记录 access/refresh token、邮箱、
  project id、原始响应或付款信息。
- **工作区重叠：** 开工前用户修改与本计划重叠，执行者必须逐文件辨认并协作合并；无法确认归属时停止，
  不覆盖、不清理、不提交。
- **长文件：** 新 provider parser/读取器放在对应 feature 文件中；不得继续增长接近 800 行的共享入口。

## 计划级完成条件

- Room 不再把消息数、事件数或 transcript 字符数显示为真实 context percentage；
- Codex、Kimi 只有在 provider 数据新鲜且 Session 匹配时显示真实水位；
- Antigravity 无 continuation 时明确为 `not_applicable`，不产生累计 Session reset 建议；
- Kimi 和通过门禁的 Antigravity account quota 仅供管理员诊断；
- context 与 quota 的缺失、过期或失败均 fail closed，不改变 turn 成败；
- 普通 payload、metadata、日志、fixture 和 Git 不含凭证或账户敏感信息；
- 所有实际执行的验证、未执行的真实 smoke、已知限制和提交哈希记录在终态 HANDOVER。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/326_PLAN_20260730_Antigravity与Kimi真实上下文水位及账户Quota.md` 的 S01。
先读取 workflow contract、本 PLAN、`docs/307_HANDOVER_20260729_CodexProvider遥测与Quota诊断S09交接.md`、
`docs/312_PLAN_20260729_KimiCodeCLI接入PlatformLocal.md` 和
`docs/315_HANDOVER_20260729_KimiCodeCLI接入PlatformLocalS04交接.md`，并保护当前工作区已有未提交改动。
只完成协议静态取证、允许的本地无外部写入验证和停止门禁记录；未经用户另行明确授权，不调用真实
Antigravity/Kimi provider，不重启服务、不发送飞书消息、不修改生产数据。修改任何代码 symbol 前先运行
GitNexus upstream impact；完成前运行适用的聚焦验证、long-file guard、`git diff --check` 和
GitNexus `detect_changes`。S01 完成或命中停止门禁后创建 HANDOVER 并停止，不自动进入 S02。
<!-- WORKFLOW_PROMPT_END -->
