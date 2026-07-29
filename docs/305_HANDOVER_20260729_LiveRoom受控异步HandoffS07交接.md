---
doc_type: HANDOVER
doc_status: in_progress
next_action: next_slice
plan: docs/296_PLAN_20260728_LiveRoom受控接力Codex遥测与长文件治理.md
slice: S07
plan_progress: in_progress
---

# HANDOVER · Live Room 受控异步 Handoff S07 交接

## 完成内容

- 为 `LiveRoom` 增加持久化 `handoffLimit`，数据库默认值为 4；为根消息增加预算快照、已接受边计数和
  assistant reply claim 状态，为 delivery 保存根消息身份。迁移会让既有房间同样获得默认值 4。
- 普通单目标 Live Room 在根链创建时固定房间预算快照；assistant reply 中恰好一个有效 `$member`
  才进入原子 claim。`@member` 只展示，多目标和未知成员记录拒绝状态并发送系统提示。
- claim 先以 assistant message 行做持久化幂等保留，再原子增加根消息计数并创建下一 delivery；重复事件
  不重复计数或创建 delivery。已接受后目标离线、停止或被移除仍消耗预算，并落 failed delivery 或明确
  系统消息。
- 当前 ACPX TaskRun/participant、delivery 和成员状态先终态；成员队列 Promise 完成并释放锁后，
  `setImmediate` 才执行 claim。claim 事务提交后才以 `waitForCompletion: false` 领取下一 delivery，
  因此 A→B→A 使用三个独立 delivery，没有嵌套调用栈或上一跳成员锁。
- `/ap room --handoff-limit=<0-32>` 支持创建或复用房间时设置；`/ap handoff-limit [0-32]` 支持查询、
  修改和用 0 关闭。修改复用现有 Feishu 会话访问边界，并写房间系统消息。
- Web 与飞书普通消息继续共用 `triggerLiveRoomMessageReplies`；`$all`、role queue、workflow watcher、
  `/ap plan` 和 `/run` 等结构化路径不创建 handoff 根链。Session continuation、成员权限和 workflow
  权限快照读取路径未改。
- 未实现 Codex App Server、telemetry 或 quota；未重启服务、发送真实飞书消息或修改生产数据。

## 验证

- Prisma：`npx prisma validate`、`npx prisma generate`，以及从空 schema 生成 PostgreSQL diff 成功；
  新迁移字段和索引由聚焦边界测试核对。
- 新增 handoff 聚焦测试覆盖 `$member`、`@member`、多目标、未知目标、A→B、A→B→A、并发重复 claim、
  根预算耗尽、0 关闭、离线目标消费预算、锁释放后调度、结构化 Workflow 禁用、Web/飞书共享入口和
  stop 对 pending delivery 的收敛。
- 既有 Live Room process registry、directed protocol、permissions、scheduling、workflows、Feishu
  relay、Feishu room initialization、Feishu Agent session 和 Feishu help 聚焦测试通过。
- `npx tsc --noEmit`；相关 ESLint 0 error、0 warning。
- `npm run check:long-files`：无文件达到 1000 行；本次涉及的 delivery、processing、Feishu command
  和新增 handoff 模块均低于 800 行。
- `git diff --check`。
- GitNexus upstream impact：`triggerLiveRoomAgentReply`、`triggerLiveRoomMessageReplies` 和
  `processLiveRoomDelivery` 为 CRITICAL，覆盖 Web、飞书、定向 chat 与 workflow dispatch；
  `handleRoomCommand` 为 HIGH。`detect_changes(staged)` 为 CRITICAL：15 个文件、22 个已索引 symbols、
  35 条流程；范围符合上述 delivery 与 Feishu 命令影响面，且已排除开工前用户的
  `AGENTS.md`/`CLAUDE.md`。新增 handoff 模块、迁移和测试尚未进入目标 HEAD 索引。

## 未执行与工作区保护

- 遵循 S07 限制，未执行真实飞书联调；Web/飞书一致性由共享入口和聚焦测试验证。
- 开工前已有的 `AGENTS.md`、`CLAUDE.md` 和 `.codex-tmp/` 未修改，不纳入 S07 提交。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/296_PLAN_20260728_LiveRoom受控接力Codex遥测与长文件治理.md` 的 S08：只补齐 Codex App
Server 的隔离与生命周期等价性。先读取目标 HEAD 的 `docs/workflow/workflow-contract.yaml`、本 PLAN、
`docs/305_HANDOVER_20260729_LiveRoom受控异步HandoffS07交接.md`、
`docs/291_REPORT_20260728_Codex真实上下文与官方配额评估.md`、S05 拆分后的 ACPX runner/continuation/
终止边界、当前 Codex adapter 与仓库锁定版本；确认并保护开工前用户的未提交改动，运行
`npm run check:long-files`。对将修改的每个 symbol 先运行 GitNexus upstream impact，HIGH/CRITICAL
先报告。核对锁定版本实际支持的 `thread/tokenUsage/updated`、`account/rateLimits/read` 和
`account/rateLimits/updated` payload；让 App Server 复用已验收的 Bubblewrap、workspace realpath、
network 快照、隔离 `/tmp` 和公开只读例外，并覆盖新 thread、resume、审批、超时、中断、PID 持久化和
Session continuation。保留普通 JSON 路径回退；隔离与生命周期等价性验收完成前不得切换默认路径，
受限 workspace 不得使用不等价模式，失败不得重复执行 turn。不得开始 S09 或其他 Slice，不实现
provider telemetry 持久化、quota 诊断或 handoff 扩展，不升级生产依赖、不重启服务、不发送真实飞书
消息、不修改生产数据。完成隔离、新 thread/resume/审批/中断/PID/安全回退聚焦测试、TypeScript、相关
ESLint、long-file guard、`git diff --check` 和 GitNexus `detect_changes` 后提交，并创建
`plan_progress: in_progress`、`next_action: next_slice` 的 S08 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
