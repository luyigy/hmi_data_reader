---
doc_type: HANDOVER
doc_status: in_progress
next_action: next_slice
plan: docs/312_PLAN_20260729_KimiCodeCLI接入PlatformLocal.md
slice: S01
plan_progress: in_progress
---

# HANDOVER · Kimi Code CLI 接入 Platform Local S01 交接

## 完成内容

- 新增 `kimi-code` Harness Adapter 和本地 executor，支持 `KIMI_CODE_CLI_PATH` 覆盖、默认 `kimi`、
  `--version` 可用性/版本检测、`--prompt` 非交互执行和 `--output-format stream-json` NDJSON 解析。
- executor 按行缓冲跨 chunk 的 JSON，流式回调 Assistant 文本，忽略 Tool/Meta 普通事件；结构化错误、
  非零退出、stderr、spawn error、timeout、SIGTERM/SIGKILL 收敛和 `onSpawn` 均进入既有结果语义。
- `kimi-code` 只允许 `platform_local`。受限权限必须经过现有 `wrapWithBubblewrap`，workspace、network
  和 `~/.kimi-code`/`KIMI_CODE_HOME` 沿用现有挂载边界；只有显式 `full_access` 才直接执行。
- Adapter 已进入现有 registry；Platform Local bootstrap、catalog normalization/fallback、本地状态、
  Feishu `/ap agents` 状态映射、real-agent 注册 API 和 legacy local dispatch 均增加稳定 key
  `kimi-code`。catalog 仍按 Adapter availability 过滤，不可用时不暴露本地 selector。
- fake CLI 聚焦测试经完整
  `executeViaLocalHarness → registry → Kimi Adapter → Bubblewrap → fake binary` 路径执行，未新增 Kimi
  专用 runner 或 Live Room delivery/handoff 分支。
- 未实现 `resume`、continuation metadata、无效 Session fallback；未修 Claude，未改变 Live Room
  handoff、投递、预算、锁或顺序。

## 验证

- `tests/kimi-code-agent.test.ts`：通过；覆盖分片 NDJSON、最终文本/流式 chunk、registry、版本
  `0.29.2`、结构化错误、非零退出、stderr、timeout、受限 workspace 越界写不落宿主和 full access
  允许宿主写。
- `tests/bubblewrap.test.ts`、`tests/live-room-permissions.test.ts`、
  `tests/live-room-handoff-boundaries.test.ts`、`tests/live-room-handoff.test.ts`：通过。
- `npx tsc --noEmit`、新增及无既有债务的相关文件 ESLint、`npm run check:long-files`、
  `git diff --check`：通过。
- `src/lib/acpx/catalog.ts` 当前仍有 HEAD 已存在的 2 条 unused-var ESLint error；
  `src/lib/agent-executor.ts` 当前仍有 HEAD 已存在的 18 条 any/unused-var error。逐文件对比 HEAD 后数量和
  规则完全一致，本 Slice 未新增 lint 违规，也未越界清理历史债务。
- GitNexus pre-edit upstream impact：`ensurePlatformLocalAgents`、`normalizeHarnessType`、
  `deriveGatewayHarnessOptions`、`executeViaLocalHarness`、`getRealAgentsStatus` 为 CRITICAL；
  `executeRealAgentTask` 为 MEDIUM；其余修改入口为 LOW。高风险入口均只做 additive Kimi 分支，并由
  上述 ACPX、Bubblewrap、Live Room handoff 回归覆盖。
- GitNexus `detect_changes(scope=compare, base_ref=master)` 已执行；分支相对 `master` 有 217 个文件、
  1459 个 symbols 和 242 条流程差异，结果为 CRITICAL。staged-only 检查为 11 个源码/测试文件、
  23 个已索引 symbols、27 条受影响流程，结果为 CRITICAL；新增 HANDOVER 不进入源码 graph，范围与
  已报告并回归的 Platform Local bootstrap、catalog、ACPX runner、status/注册入口一致。

## 环境与边界

- 开工前已有 `AGENTS.md`、`CLAUDE.md`、Codex 水位/Live Room 源码、测试和 `.codex-tmp/` 改动；
  均未修改、清理或纳入 S01 提交。
- PLAN 记录的 `/home/hello/.kimi-code/bin/kimi` 和版本 `0.29.2` 在当前 Session 容器中不存在；
  PATH 虽包含该目录，但主机状态检查会正确返回 unavailable。因此本次版本和执行验收来自可注入 fake
  CLI，未声称真实 Kimi 模型调用通过。
- GitNexus 索引只落后当前 PLAN 文档 commit，源码图与 HEAD 一致。尝试以 `/tmp` 安装的 CLI 刷新时，
  容器因缺少 C 编译器无法构建可选 parser；本次使用现有源码索引完成 impact/detect，未修改仓库依赖
  或 lockfile。
- S02 在恢复本机 Kimi binary 或取得同版本真实 `stream-json` fixture 前，不得猜测 Session ID 字段；
  不得用 fake-only 字段写 continuation metadata。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/312_PLAN_20260729_KimiCodeCLI接入PlatformLocal.md` 的 S02：只实现 Kimi Code 同 Session
continuation。先读取目标 HEAD 的 `docs/workflow/workflow-contract.yaml`、本 PLAN 和
`docs/313_HANDOVER_20260729_KimiCodeCLI接入PlatformLocalS01交接.md`；确认并保护开工前用户未提交
改动，运行 `npm run check:long-files`，并对将修改的每个 function/class/method 先运行 GitNexus
upstream impact，HIGH/CRITICAL 先报告。先恢复/定位 Kimi Code `0.29.2` binary 或取得同版本真实
`stream-json` fixture，确认 `session.resume_hint` 的 `session_id` 与事件顺序；无法取得时停止并明确
blocked，不得从帮助文本或 fake-only 字段猜协议。在 Adapter 实现 `resume`、`readContinuation` 和
`isInvalidContinuationError`，复用 `findLatestParticipantSession`、既有单次 continuation retry 和
`persistPlatformLocalSessionMetadata`，metadata 优先使用通用 `lastSessionId`、`lastSessionKind` 与
`sessionTracking`，不建新表。fake CLI 覆盖首轮 Session ID、第二轮同 Session、无效/丢失 Session
仅一次 fresh fallback，以及 stop/timeout/失败不持久化坏 Session。不得开始 S03，不修 Claude，不改变
Live Room handoff/delivery/预算/锁/顺序，不接 remote SSH 或 gateway，不重启服务、不发送真实 Feishu
消息、不修改生产数据。完成聚焦测试、相关 continuation 回归、TypeScript、相关 ESLint、
long-file guard、`git diff --check` 和 GitNexus `detect_changes` 后精确提交，并创建指向 S03 的
HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
