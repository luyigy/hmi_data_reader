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

# PLAN · Kimi Code CLI 接入 Platform Local

## 目标

把本机 Kimi Code CLI 作为一等 `platform_local` Harness 接入 Agent Platform，使它可以被发现、
加入 Live Room、执行任务、流式回传最终文本，并在确认 CLI Session 语义后支持同成员续接。

计划只复用现有 `HarnessAdapter + registry`、ACPX runner、Session metadata 和 Live Room delivery；
不新增第二套执行框架，不把 Kimi 分支散落到 Live Room 调度代码。

## 已确认事实

- 本机可执行文件为 `/home/hello/.kimi-code/bin/kimi`，当前版本 `0.29.2`。
- CLI 原生支持：
  - `--prompt <prompt>` 非交互执行；
  - `--output-format stream-json` 流式结构化输出；
  - `--session <id>` 与 `--continue` Session 续接；
  - `--yolo`、`--auto` 权限模式；
  - `--model <model>` 模型选择。
- 当前本地执行已经统一经过 `src/lib/harness/registry.ts` 和
  `src/lib/acpx/runner-harness.ts`；能力、权限和 continuation 可由 Adapter 声明，无需再给 runner
  增加 Kimi 专用执行分支。
- `src/lib/harness/bubblewrap.ts` 已提供受限 Feishu workspace 的 Linux 隔离边界，可复用；不得仅靠
  Kimi 的自动批准参数宣称 workspace 隔离。
- `platform-local-init.ts`、`real-agents/index.ts`、catalog、注册 API 和部分状态展示仍含 Harness
  白名单，Kimi 必须在这些现有入口中一致注册。
- 开工时工作区已有 `AGENTS.md`、`CLAUDE.md`、Codex 水位相关源码和测试改动；这些改动属于用户，
  不修改、清理或混入 Kimi 提交。
- `npm run check:long-files` 当前通过，没有达到 1000 行阻断阈值的源码。

## 边界与决策

### 包含

- `kimi` 可执行文件覆盖配置、可用性和版本检测；
- 非交互 prompt 执行、NDJSON/`stream-json` 增量解析、stderr、退出码、超时和进程停止；
- Harness Adapter 注册、能力/权限声明、Platform Local bootstrap、catalog、状态和注册 API；
- 受限 workspace 复用 Bubblewrap，full access 使用现有权限配置，不自行扩大授权；
- Session ID 提取、metadata 持久化、同成员 continuation 和失效 Session 的既有 fallback；
- 聚焦 fixture 测试、ACPX/Live Room 自动化回归，以及经用户授权后的真实 Feishu 验收。

### 不包含

- 不修 Claude `input_tokens` 异常，不为 Claude 增加自动重试；
- 不改变 `$member` handoff 的投递、预算、锁、顺序或失败语义；
- 不接 `remote_ssh`、OpenClaw gateway、Kimi Web/ACP server；
- 不新增通用 Provider、事件总线、Session 数据表或数据库迁移；
- 不承诺 CLI 未实测支持的热权限更新、立即中断或交互式审批；
- 不重启服务、不发送真实 Feishu 消息，除非用户在验收 Slice 明确授权。

## S01：最小可用 Platform Local Harness

先对本 Slice 实际修改的每个 function/class/method 运行 GitNexus upstream impact；HIGH 或 CRITICAL
先报告再编辑。实现最小 Kimi 执行路径：

1. 新增 `src/lib/real-agents/kimi-code-agent.ts`，使用 `KIMI_CODE_CLI_PATH` 覆盖或默认 `kimi`，
   支持版本检测、非交互 prompt、`stream-json` 按行解析、增量文本回调、结构化错误、stderr、退出码、
   timeout 和 `onSpawn`。
2. 为 parser/runner 留一个最小 fake CLI fixture 测试，不调用真实模型；至少覆盖分片 NDJSON、最终文本、
   非零退出、结构化错误和超时。
3. 新增 `src/lib/harness/adapters/kimi-code.ts` 并注册到现有 registry。能力和权限只按已验证行为声明；
   unsupported 组合 fail closed，不用 `recorded_only` 冒充实际隔离。
4. 受限 workspace 复用 `wrapWithBubblewrap`，只挂载 CLI、Kimi 必需配置和已授权 workspace；
   `networkAccess` 沿用现有隔离设置。full access 才允许无 Bubblewrap 执行。
5. 用稳定 Harness key `kimi-code` 接入现有 Platform Local bootstrap、catalog normalization、本地状态、
   real-agent 注册 API 和必要的状态展示。避免在 `runner-harness.ts`、Live Room delivery 或 Feishu
   调度中新增 Kimi 专用执行分支。

完成标准：

- fake CLI 聚焦测试证明流式解析、终态、错误和 timeout 正确；
- `getHarnessAdapter('kimi-code')` 可用，本机状态能读取版本 `0.29.2`；
- catalog 只在 Kimi 可用时暴露 `platform_local:<hostname>:kimi-code`；
- 受限 workspace 的越界写被 Bubblewrap 阻止，full access 与受限模式没有权限混淆；
- Kimi 可通过现有 ACPX/Live Room 本地执行链完成一次 fixture 任务；
- 相关 TypeScript、ESLint、聚焦测试、`npm run check:long-files`、`git diff --check` 通过；
- 提交前运行 GitNexus `detect_changes({scope: "compare", base_ref: "master"})`，只提交 Kimi 文件和
  S01 HANDOVER，不夹带开工前改动。

## S02：同 Session continuation

以 S01 已捕获的真实 `stream-json` fixture 为准确认 Session ID 字段和事件顺序；不从帮助文本猜协议。
在 Adapter 实现 `resume`、`readContinuation` 和 `isInvalidContinuationError`，复用
`findLatestParticipantSession`、既有 continuation retry 和 `persistPlatformLocalSessionMetadata`。
metadata 使用通用 `lastSessionId`、`lastSessionKind` 与 `sessionTracking`；只有确有兼容需要时才增加
`kimiSessionId`，不建新表。

用 fake CLI 覆盖：

- 首轮 Session ID 提取与 TaskRun/participant metadata 持久化；
- 第二轮使用同一 Session ID，输出可证明继承首轮上下文；
- 无效或丢失 Session 只触发一次既有 fresh-session fallback，不重复执行成功 turn；
- stop、timeout 和进程失败不把坏 Session 标记为成功。

完成标准：

- 同一 Live Room 成员的后续消息走同一 Kimi Session；
- `/ap new-session` 后不复用旧 Session；
- continuation 失败安全回退且不会重复交付或扩大权限；
- 聚焦测试、相关 Session/continuation 回归、TypeScript、ESLint、long-file guard、`git diff --check`
  和 GitNexus `detect_changes` 通过；
- 只提交 S02 变更与 S02 HANDOVER。

## S03：集成回归与验收

在不触碰生产数据的条件下完成：

1. Platform Local status/catalog/selector 回归；
2. Live Room 添加 Kimi、一次执行、连续两轮、stop/timeout、无效 Session fallback；
3. safe workspace 与 full access 权限边界；
4. Codex、Claude、Antigravity、DeepSeek、Gemini 和 Pi 的现有注册/执行路径不回归；
5. TypeScript、相关 ESLint、全部聚焦测试、`npm run check:long-files`、`git diff --check` 和
   GitNexus `detect_changes({scope: "compare", base_ref: "master"})`。

真实服务重启、真实 Feishu `/ap add` 和消息 smoke test 必须再次取得用户授权。获授权后验证：

- `/ap agents` 显示 Kimi online 和正确版本；
- Kimi 能加入当前房间并完成一轮回复；
- 第二轮延续同一 Session；
- `/ap new-session` 后创建新 Session；
- stop/失败会释放成员状态并给出明确错误。

完成后创建 `plan_progress: complete`、`next_action: await_acceptance` 的 S03 HANDOVER 并停止，不自动扩展
到远程 SSH、ACP server 或 Claude 修复。

## 风险与控制

- **共享注册面：** registry、Platform Local bootstrap、catalog 和 status 有多个 Harness 消费者；
  修改其 symbol 前必须执行 upstream impact，HIGH/CRITICAL 先报告。
- **协议不稳定：** parser 以当前 `0.29.2` 的真实 fixture 为准，未知事件忽略并保留 stderr；不把一次
  实测字段提升为通用事件抽象。
- **权限误报：** `--auto`/`--yolo` 只控制 Kimi 内部确认，不等于沙箱。safe workspace 必须有
  Bubblewrap；无法建立等价隔离就 fail closed。
- **重复执行：** continuation fallback 复用现有单次 retry，任何已成功 turn 不得自动重放。
- **工作区保护：** 每个 Slice 精确 `git add` 自己的文件；不清理、覆盖或提交用户现有改动。
- **长文件保护：** 现有文件不得达到 800 行预警线；新职责优先放入 Kimi executor/adapter，而不是
  继续增长共享入口。

## 计划级完成条件

- `kimi-code` 作为一等 Platform Local Harness 可发现、可执行、可停止、可续接；
- safe workspace 不越权，权限声明与实测一致；
- Live Room/Feishu 入口复用同一 selector、Session 和 delivery 语义；
- 既有 Harness 无回归，自动化验证结果记录在终态 HANDOVER；
- 未获授权的真实外部动作明确列为未执行，不伪称通过。

<!-- WORKFLOW_PROMPT_START -->
执行 312_PLAN_20260729_KimiCodeCLI接入PlatformLocal.md 的 S01：先保护开工前已有工作区改动，按 AGENTS.md
对每个将修改的 function/class/method 运行 GitNexus upstream impact 并报告风险；复用现有
HarnessAdapter、registry、Bubblewrap、Platform Local bootstrap 和 catalog，实现 Kimi Code CLI
最小可用本地 Harness及 fake CLI 聚焦测试。只完成 S01，不实现 continuation，不修 Claude，不改变
Live Room handoff。验证通过后运行 GitNexus detect_changes，精确提交 S01 变更，并创建指向 S02 的
HANDOVER。
<!-- WORKFLOW_PROMPT_END -->
