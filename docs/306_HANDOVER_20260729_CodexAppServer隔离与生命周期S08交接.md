---
doc_type: HANDOVER
doc_status: in_progress
next_action: next_slice
plan: docs/296_PLAN_20260728_LiveRoom受控接力Codex遥测与长文件治理.md
slice: S08
plan_progress: in_progress
---

# HANDOVER · Codex App Server 隔离与生命周期 S08 交接

## 完成内容

- 当前可用 Codex CLI 为 `0.144.5`；仓库 `package.json` / `package-lock.json` 没有锁定
  `@openai/codex`。使用该安装版本生成 experimental JSON schema，确认：
  - `thread/tokenUsage/updated` 为
    `{ threadId, turnId, tokenUsage: { last, total, modelContextWindow } }`；
  - `account/rateLimits/read` 返回 `rateLimits`、可选的 `rateLimitsByLimitId` 和 reset credits；
  - `account/rateLimits/updated` 为必须合并到最近 snapshot 的稀疏 `{ rateLimits }`。
- App Server 继续复用已验收的 `wrapWithBubblewrap`，实际覆盖 workspace realpath、network 快照、
  每次运行隔离 `/tmp`、Codex 配置挂载和公开只读例外；受限 workspace 的协议 `cwd` 同样使用 realpath。
- 新 thread 与 resume 都向 App Server 传递相同的 `cwd`、sandbox、approval policy 和 model；turn 同步
  固定 `cwd`、approval、model 与 reasoning effort，Session continuation 仍复用原 Codex thread id。
- 在命令和文件审批之外，补齐当前协议的 `item/permissions/requestApproval`；批准只回传本次请求的
  permission profile 且 scope 固定为 `turn`，拒绝返回空权限。外层 Bubblewrap 仍是不可扩大的真实边界。
- timeout 和外部 interrupt 都终止 App Server 子进程并收敛为失败；`onSpawn` 仍接入 S05 既有
  process registry 与 PID metadata 持久化，`onThreadStarted` 仍接入既有 Session metadata。
- App Server 错误现在携带是否已提交 `turn/start`。只有 turn 尚未提交且 workspace 不受限时才允许回退
  普通 JSON 路径；受限 workspace 拒绝不等价回退，turn 一旦提交也绝不重跑，避免重复执行。
- 默认路径没有切换：`approvalPolicy=never` 继续使用普通 JSON，App Server 仍只服务需要交互审批的路径。
- 未实现 provider telemetry 持久化、quota 诊断、水位展示或 handoff 扩展；未升级生产依赖、重启服务、
  发送真实飞书消息或修改生产数据。

## 验证

- `src/lib/real-agents/codex-app-server.test.ts`：通过。使用本地协议 fixture 覆盖受限 Bubblewrap、realpath、
  宿主 `/tmp` 不可见、新 thread、resume、审批、超时、中断、spawn PID、turn 前 JSON 回退、受限
  workspace 禁止回退和 turn 后禁止重试。
- `tests/bubblewrap.test.ts`、`tests/live-room-process-registry.test.ts`：通过。
- `npx tsc --noEmit`：通过。
- 相关 ESLint：0 error、0 warning。
- `npm run check:long-files`：无文件达到 1000 行；本次 3 个 TypeScript 文件均低于 800 行。
- `git diff --check`：通过。
- 使用不更新分支 ref 的临时 Git tree/commit 校验目标 HEAD 合同：PLAN 与本 HANDOVER 均通过
  `workflow:validate`，动作分别为 `start_first_slice` 与 `next_slice`。
- `tests/workflow-execution-policy.test.ts` 的纯 policy 断言完成后，在读取仓库现有
  `config/projects.yaml` 时因其中 `/data1/code/workflow-test` 不存在而失败；该环境配置不属于 S08，
  本次未创建目录或修改配置来掩盖失败。
- GitNexus upstream impact：`runCodexAppServer` 为 LOW，2 个直接调用者、2 条受影响流程；
  `executeCodexCLI` 为 LOW，1 个直接调用者、2 条流程；`resumeCodexSession` 为 LOW，1 个直接调用者；
  审批转换和响应为 LOW、无已索引上游依赖。
- GitNexus `detect_changes(scope: staged)`：LOW，3 个源码、19 个已索引 symbols、0 条受影响流程；
  新 HANDOVER 不进入源码 graph。

## 工作区保护

开工前已有的 `AGENTS.md`、`CLAUDE.md` 和 `.codex-tmp/` 未修改，不纳入 S08 提交。为执行仓库要求的
GitNexus impact，在当前用户 npm 全局前缀安装了 GitNexus CLI `1.6.6`；未修改仓库依赖或 lockfile。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/296_PLAN_20260728_LiveRoom受控接力Codex遥测与长文件治理.md` 的 S09：只实现 Codex provider
telemetry 持久化、真实水位降级和管理员 quota 诊断。先读取目标 HEAD 的
`docs/workflow/workflow-contract.yaml`、本 PLAN、
`docs/306_HANDOVER_20260729_CodexAppServer隔离与生命周期S08交接.md`、
`docs/291_REPORT_20260728_Codex真实上下文与官方配额评估.md`、当前 App Server、Codex adapter、
ACPX metadata/Session continuation、Live Room 水位序列化与管理员命令边界；确认并保护开工前用户的
未提交改动，运行 `npm run check:long-files`。对将修改的每个 symbol 先运行 GitNexus upstream impact，
HIGH/CRITICAL 先报告。基于锁定/当前安装版本的真实 payload，让 App Server 回调
`thread/tokenUsage/updated` 和账户 rate-limit snapshot/update；Harness/ACPX 仅把最新 thread usage、
采集时间和来源写入 participant 既有 `controlMetadata`，不得新增 Prisma migration。Live Room 序列化
优先使用新鲜 provider usage，缺失、乱序或过期时回退既有 `estimated`，Web 与飞书复用同一水位入口。
quota 只进入既有管理员诊断命令，按 Codex 账户边界授权和缓存，只显示允许的 used percent、窗口和 reset
时间；普通 Room/API payload 不得包含 quota、账户标识、凭证或原始认证数据。保留 JSON 与非 Codex
估算路径，不修改 S08 的隔离、审批、回退和禁止重复 turn 语义。不得开始 S10 或其他 Slice，不扩展
handoff、不升级生产依赖、不重启服务、不发送真实飞书消息、不修改生产数据。完成 provider/estimated、
新 thread/resume/审批、乱序/过期、quota 权限与普通 payload 隔离聚焦测试、TypeScript、相关 ESLint、
long-file guard、`git diff --check` 和 GitNexus `detect_changes` 后提交，并创建
`plan_progress: in_progress`、`next_action: next_slice` 的 S09 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
