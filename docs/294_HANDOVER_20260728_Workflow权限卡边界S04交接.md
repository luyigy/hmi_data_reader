---
doc_type: HANDOVER
doc_status: in_progress
next_action: next_slice
plan: docs/288_PLAN_20260728_Workflow权限边界与同Session校验修复.md
slice: S04
plan_progress: in_progress
---

# HANDOVER · Workflow 权限卡边界 S04 交接

## 完成内容

- 普通 permission card 现在明确显示命令、当前 workdir、workspace 边界、授权范围和 ISO 有效期；批准按钮
  明确限定为当前启动策略内的本次操作，不修改 sandbox、network、writable roots 或 Workflow policy。
- Platform Local Codex 的 on-request app-server 复用现有 Bubblewrap；受限运行以 workdir/配置根为
  workspace，Codex 持久状态迁入 workspace 的 `.git/agent-platform/codex/`。越出 workspace 的文件
  修改请求直接返回 deny，不创建 interaction、不发送可批准卡，操作系统沙箱仍是最终边界。
- 只有 Platform Local Codex 的真实 `in_process` 请求显示批准动作。其他 Harness 的权限请求只展示
  adapter 不支持原进程批准并保留拒绝动作；伪造 approve action 也会被 resolver 拒绝。
- 删除普通 interaction approve 为非 Codex Session 写入 Full Access override 的路径。普通批准沿用
  启动时权限快照，不再变更 Session permission policy。
- Full Access 保持独立管理员审批，管理员本人也不能绕过审批卡。卡片展示原命令、workdir、Full Access
  范围、新 Session 生效语义和 15 分钟有效期；`grant/rights full` 批准后转换为
  `new-session --profile=full_access`，旧进程确认停止并创建新 Session 后才写入权限。
- Session 停止、重置/替换、进程超时/消失或正常结束时，相关 pending interaction 会立即进入
  `cancelled` 或 `expired`，同时以 deny 收口 in-process waiter；旧卡无法恢复已结束进程。
- 未修改 Workflow workspace policy、S03 validator 同 Session 纠正、watcher 通知、数据库 Schema 或
  目标业务仓库。

## 验证与影响

- 新增 `npm run test:feishu-permission-card`：覆盖卡片字段、Codex/其他 Harness 按钮能力、workspace
  内单次批准边界、workspace 外拒绝不发卡、Full Access 新 Session 转换和 pending interaction 取消。
- Codex app-server、Feishu access approval、Agent Session stop、Bubblewrap、Workflow execution
  policy 聚焦测试通过；S03 的 workflow completion gate 与 watcher 回归测试通过。
- `npx tsc --noEmit` 和相关 ESLint 通过。`runner.ts` 为 1795 行，低于 1798 行开工基线；
  `feishu.ts` 未增长，没有新增达到 1000 行的文件。
- GitNexus pre-edit impact：`executeViaLocalHarness`、`handleHarnessInteractionRequest`、
  `executeParticipant`、`rotateTaskSession`、`interruptLiveRoomMemberReplies` 为 CRITICAL；
  `runCodexAppServer`、`resolveInteractionRequestWithContinuation`、`reconcileTaskRun`、
  `requestFullAccessApproval`、`sendAdminCard`、`handleNewSessionCommand` 为 HIGH。改动限定在启动边界、
  单次审批和 interaction 生命周期收尾，相关共享流程均由上述聚焦及回归测试覆盖。
- GitNexus staged-only `detect_changes` 为 CRITICAL：44 个 changed symbols、51 个上游影响、18 个已索引
  代码文件；受影响流程集中在预期的 Codex 启动、Feishu 管理员升级和 TaskRun/Session 收尾路径，
  没有新增 S03 validator/watcher 或目标业务仓库改动。
- 开工前已有的 `AGENTS.md`、`CLAUDE.md` 和 `.codex-tmp/` 改动未修改、未纳入本次提交。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/288_PLAN_20260728_Workflow权限边界与同Session校验修复.md` 的 S05：只用隔离测试项目验收
本 PLAN 已实现的完整流程并完成终态交接，不再扩展权限模型、validator 或 watcher 行为。先读取目标 HEAD
的 `docs/workflow/workflow-contract.yaml`、本 PLAN、`docs/294_HANDOVER_20260728_Workflow权限卡边界S04交接.md`
以及 S01-S04 聚焦测试；对验收中必须修改的每个 symbol 先运行 GitNexus upstream impact，
HIGH/CRITICAL 先报告。不得修改目标业务仓库，不新增功能，不重启服务或操作真实生产数据。使用隔离测试
项目验证 `/ap workflow policy show/set`、Workflow 启动、项目内写入、workspace 外与宿主 `/tmp`
拦截、公开只读例外、网络请求、validator 原 Session 最多两次纠正、原 Session 不可用通知、旧权限卡
失效，以及非管理员/非法预设拒绝；确认配置展示与实际执行一致。运行相关聚焦测试、TypeScript、ESLint、
long-file guard、`git diff --check` 和 GitNexus `detect_changes`，创建 `plan_progress: complete`、
终态 `next_action` 的 S05 HANDOVER 并提交；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
