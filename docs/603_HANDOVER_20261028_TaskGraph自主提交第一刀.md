---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: null
slice: null
plan_progress: complete
---

# Task Graph 自主提交第一刀

## 授权、工作区与范围

用户于 2026-10-28 在 Feishu DM 08a216 明确要求直接实施、自测、提交和 HANDOVER，不部署生产。本次按这一直接授权执行，不创建或批准真实任务路线，不操作 watcher cursor/pending，不接续 Integrator、Handoff 或 Architect 的后续实现。

- 基线：已 fetch 并核对 `gitee/oss-prep`，为 `0a4f69d`。
- 实施分支：`implementation/thin-graph-603`。
- 隔离工作区：`/data1/code/agent-platform-v2/output/worktrees/thin-graph-603`。
- 源码与本交接同一提交；以该分支包含本文件的提交为交付版本。
- 主工作区 `oss-prep` 未集成这些源码，未重启或部署任何生产服务。测试使用一次性 PostgreSQL、独立 schema、临时仓库和 Bubblewrap。

第一刀只支持每个 Node 一个 execution、无需跨分支合并的正式交付。多执行、多仓及冲突集成的旧合同代码保留；不迁移已批准快照。

## 真实调用链与原问题

1. `coordinator.executeJob` 取得执行 claim/Writer，准备工作树，登记 dispatch，调用 `executeAcpxTaskRun`。
2. ACPX 在启动时通过 `bindTaskRunResult` 固定运行身份和快照。`runner-harness` 准备沙箱；原任务图 Git 元数据全部只读，Agent 不能自行提交。
3. `recordedImplementationResult → recordTaskRunResult → parseGraphResult → parseImplementationResult` 消费真实 TaskRun 输出；普通回答与正式交付分开。
4. 原调度路径在这一边界调用 `commitJobWorktree` 代提交，再 `integrateJobWithRetry`，通过 `applyExecutionOutcome` 发布 execution。
5. `markNodeIntegrationsReady → verifyNodeOnce → submitNodeVerificationTx` 发布 Node，再由 `releaseReadyNodes` 放行后继。旧 `agent_owned_v1` 的无 Reviewer 路径仍要求 `ticketVerification`。

聊天室另有 `publishRoomResult` 发布入口。本次也让新合同在该入口复用同一套自主提交核验与引用 CAS，避免新合同被另一入口按旧集成方式处理。

GitNexus 更新索引后确认了调度与聊天室的发布调用方；变更分析涉及共享交付/ACPX 边界，工具给出 critical 范围提示。本次以实际代码和隔离回归判断，不把图谱的风险标签当作验证结论。

## 新合同与行为

明确选择 `deliveryContract: agent_commit_v1`，可写在 GraphDefinition 顶层或 `spec-package.json` 的 `issueRoute` 中。导入、提议默认处理、确认卡和批准快照均保留这一选择；合同值参与快照哈希。未选择的新提议仍默认 `agent_owned_v1`，已有无合同或 v1 快照保持原语义。

新合同只接受一个 execution 和正式交付模式，不接受 `implement` 的未验收状态。Agent 收到自主编码、自测和 Git 提交指令，报告唯一正式结果：

```text
TASK_GRAPH_IMPLEMENTATION {"status":"delivered","commit":"完整 Git SHA","note":"实际交付说明","evidence":["实际验证命令与结果"]}
```

- 平台不运行 add/commit/merge，不重跑 `launchConfig.checks` 或 `integrationChecks`。这些要求和命令传给 Agent，由其自主验证。
- 无 Reviewer 且无有效的其他 Gate 时，合法 delivered 即可成为 `passed`，无需 `ticketVerification`；`acceptance.checks` 可为空。
- 人工批准、已配置独立验收、有效的架构 Gate 仍按原机制执行。对这些模块的改动仅是让既有约束识别新合同，没有实施新的架构角色流程。
- 普通聊天、working、blocked、failed、缺失或错误 SHA、重复标记、工作区残留修改和错误身份不会完成 Node。
- 现有 Node 发布事务及后继释放幂等继续生效；重复回调或调度周期只启动一次后继。

## 形式核验和权限边界

新增 `agent-commit.ts` 集中负责：

- 对照冻结配置检查仓库、gitRef、基线、实施者与 launchConfig。
- 检查服务端绑定的 TaskRun、参与者成功状态、图/节点/execution/任务身份和批准快照。
- 在 ACPX 仍持有 Writer 时记录最终源码 SHA、tree、脏状态和输出哈希；发布时要求 Writer 已真实退出，回执 SHA 与该最终源码完全一致。
- 复核 Git 注册的工作树、分支、common-dir、基线及候选祖先关系，拒绝暂存或未暂存修改及非忽略的未跟踪文件。
- 仅通过 `update-ref` CAS 推进既有集成引用。遇到分歧或引用被检出，保留现场，不生成合并提交。

“提交来源”由 TaskRun 最终源码与执行身份证明，不把可自行配置的 Git author 字符串当成身份凭证。

新工作树采用私有 `.../<job-hash>/head` 分支目录。Agent 只获得对象库、本工作树元数据及该私有 ref/log 目录的写权限；主分支、其他 execution 的引用和共享 Git 配置保持只读。沙箱实际验证了 Agent 可 add/commit，同时不能改主分支或共享 Git config。旧任务图保持 Git 只读。

运行资源准备会把已批准目录汇入只读集合；因此在新合同下明确保留上述受限 Git 写目录。没有放宽全局沙箱、外部资源授权或 Writer 排他规则。平台 `commitJobWorktree` 另对新私有分支拒绝代提交，防止异常/旧恢复路径误用。

## 重启恢复

真实子进程在 ACPX TaskRun 完成、调度器收取结果之前以 71 退出，父进程随后使用正常 `runTaskGraphCycle` 恢复。

回归发现新执行仍可能保留 prepare 阶段，导致已完成 TaskRun 被再次实施。新合同现在在启动实施前记录 implement；恢复直接消费已保存的 delivered 与 Agent SHA，不再次启动实施者或代提交。崩溃前的 failed/blocked 保持业务停止，不被平台重派。普通聊天和未提交现场仍不冒充交付。

## 验证与证据

主回归命令：

```sh
node scripts/sandbox-postgres-session.mjs run task-graph-agent-commit
node scripts/sandbox-postgres-session.mjs run task-graph-worktree task-graph-integration-retry thin-room-results task-graph-restart-recovery
npm run test:task-graph-workflow
npx tsc --noEmit --pretty false
npm run check:long-files
```

新回归走真实 Coordinator → ACPX → TaskRun → 结果收取 → execution → Node → 后继链，使用确定性的 harness 测试替身；替身在真实 Bubblewrap 内调用 Git 并自测，登记实际子进程退出证据。没有调用付费模型，也没有将测试替身描述为线上 Coding Agent 实测。

- 先红：`output/thin-graph-red.log`，基线拒绝未知合同；随后真实沙箱还暴露 Git 写目录被只读覆盖的问题，修复后转绿。
- 新合同 18 个场景：普通交付、人工 Gate、已有架构 Gate、普通聊天、working、blocked、failed、未跟踪残留、暂存残留、缺 SHA、错误 SHA、重复结果、分支变更、错误身份、聊天室交付、真实进程退出后的 delivered/failed/blocked 恢复。
- 每个新场景都断言平台业务命令执行 **0**、平台代提交函数调用 **0**；成功路径保留 Agent SHA，并断言后继只启动一次。
- 旧 worktree 生命周期、分歧/CAS 集成、多仓聊天室验收、重复发布、人工 Gate 和真实调度器退出恢复通过。
- 显式 Issue 包合同从导入到审批快照保持不变；提议不派发、Issue 漂移阻止批准、重复确认幂等，通过。
- 旧 `agent_owned_v1` 的 31 类场景分批覆盖通过，包括单/多执行、多仓、冲突、自查、独立验收、人工 Gate、旧 implement、失败和补收。一次批量运行在 tester-missing 的 attention/verifying 状态断言失败；基线定向及修改后剩余 11 类定向重跑通过，没有为通过断言修改生产恢复逻辑或原测试。
- TypeScript、workflow 单测、长文件守卫及 diff whitespace 校验通过。开工及结束均无达到 1000 行阈值的文件。

本机日志在主仓 `output/thin-graph-*.log`；一次性数据库及进程清理证据在实施工作区的 `output/sandbox-postgres-runs/*/evidence.json`。核心证据目录：

- 新合同最终回归：`2026-10-28T163046-3633728`。
- 旧集成/聊天室/重启：`2026-10-28T162645-3581574`。
- 旧合同剩余 11 类定向：`2026-10-28T162800-3602562`（临时用原测试已有 GRAPH_QUALITY_CASE 选择入口，原测试文件已还原）。
- Issue 提议：`2026-10-28T162431-3549263` 中的 issue-proposal 子套件通过。

额外旧 `task-graph-sandbox` 套件在 `python --version` 处以 127 失败，原因为隔离环境没有 `python` 命令；未修改的 `0a4f69d` 工作区复现相同错误。该项未宣称通过，也未借本刀修改全局工具链。新合同自身的真实沙箱 Git 与权限回归通过。

## 修改文件

- `src/lib/task-graph/agent-commit.ts`：新合同的 Git 权限、来源核验和引用发布。
- `src/lib/acpx/runner-harness.ts`：按新合同装配受限 Git 权限。
- `src/lib/task-graph/domain.ts`、`issue-route.ts`、`proposals.ts`、`proposal-card.ts`、`role-configuration.ts`：显式合同、单 execution 范围、提议/卡片和角色选择。
- `src/lib/task-graph/prompts.ts`、`implementation-result.ts`：自主提交指令、SHA 回执和业务停止语义。
- `src/lib/task-graph/coordinator.ts`、`execution-progress.ts`、`store.ts`：调度、execution 和 Node 发布边界。
- `src/lib/task-graph/task-run-result.ts`、`result-source.ts`、`room-result-publication.ts`：真实 TaskRun 来源证据与聊天室共用发布。
- `src/lib/task-graph/worktree.ts`、`restart-recovery.ts`：私有 ref、禁止代提交和退出恢复。
- `src/lib/task-graph/acceptance-models.ts`、`architecture-review.ts`、`review-publication.ts`、`repair.ts`：让新合同保留既有模型/其他 Gate 和停止约束。
- `tests/task-graph-agent-commit.test.ts`、`tests/fixtures/agent-commit-crash-worker.ts`、`tests/task-graph-issue-proposal.test.ts`、`scripts/test-task-graph-postgres.mjs`：端到端、进程退出、合同导入和回归注册。
- `docs/architecture/issue-route-packages.md`、本 HANDOVER：合同使用与交付记录。

## 后续边界

本刀已可供审阅与后续集成。尚未合入主工作区、推送远端或部署生产；不自动选择新合同替换任何旧运行。若继续部署或开展跨分支 Integrator、Handoff、Architect，需按用户后续明确范围另行实施。此交接 `next_action: none`，不触发自动接续。
