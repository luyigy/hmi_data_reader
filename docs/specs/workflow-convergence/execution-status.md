# 实施检查点

记录时间：2026-10-17 17:00，Asia/Shanghai。

用户最新要求：拆成独立 Session 实施。本 Session 收尾正在验证的 W4 后停止，不继续 W5，不自动启动下一个 Session。本文件记录当前事实，不触发 watcher 或任务派发。

## 代码位置

- 集成分支：`feat/workflow-convergence-20261017`。
- 工作目录：`/data1/code/agent-platform-v2-workflow-convergence`。
- 比较基线：`0374187`。
- 当前代码尚未合入 `/data1/code/agent-platform-v2` 的 `oss-prep`，未推送、未部署、未重启服务。
- 原工作目录的六个未提交卡片文件、其他未跟踪资料保持原状。六个卡片文件的既有改动已读入集成分支，在其上接入 Issue 提审；合入时须对账保留，不能直接覆盖原工作目录。

| Slice | 已提交内容 | 提交 | 验证边界 |
| --- | --- | --- | --- |
| W1 / IKMG1O | 获批成员进入子话题；只读问答使用独立执行身份；补材料后恢复验收 | `659131a` | 隔离 PostgreSQL、真实入站处理和 Harness 边界模拟；未做部署后真实飞书验收 |
| W2 / IKMG1P | 任务私有运行目录、细分权限、工具链、认证目录、平台受控 Git 提交与只读检查 | `c62bf56` | 真实 Bubblewrap / Git 正反探针；真实 Codex / Kimi 认证调用；S05 原脚本只读重跑 |
| W3 / IKMG1Q | 从 Issue 导入依赖和目标；飞书 Spec 选择；冻结及复核来源；精简卡片 | `282ad8c` | 真实 Gitee 五张 tickets 读取；GitHub 原生关系 API 的传输边界模拟；隔离卡片确认 |
| W4 / IKMG1R | 派发前核对 Issue 漂移；独立支线继续；交付回写 outbox、回读及不确定发送对账 | `3062a08` | 真实 Git/Bubblewrap 并行、汇合、验收退回及恢复；外部 Tracker 传输模拟 |
| W5 / IKMG1S | 仅核对既有业务状态与仓库，尚未实施迁移 | 无 | 见下方阻塞 |

W4 的提交也补上平台 Git 的 smudge、merge driver 和 textconv 限制。全部 Issue 保持开放；本地通过不等于已部署或已满足全部业务验收。

## 最近验证

已通过 `npm run test:task-graph-postgres`、`npm run test:task-graph-workflow`、`npx tsc --noEmit`、变更文件的 Next lint、`npm run check:long-files` 和 `git diff --check`。

任务图测试使用临时 PostgreSQL schema，不写生产表。W4 的实际协调器在临时仓库将 A/B 分到不同 worktree；B 首次验收不通过时 C 等待；恢复 B 只重跑验收，随后 C 继承两支提交并自动执行。各角色共用任务工作区，源 main 没有移动。外部评论响应丢失、关闭失败和重复同步均未重复 POST 或重做实施。

详细日志在原工作目录的 `.runtime/`，包括：

- `w4-checkpoint-gate.log`、`w4-checkpoint-types.log`、`w4-checkpoint-lint.log`。
- `w3-real-gitee-import.json`：真实父 Spec 与五张 tickets 的解析结果。
- `w2-native-auth.log`：真实 Codex / Kimi 各一次最小模型请求成功。
- `w2-s05-managed-check.log`：固定提交 `3350543` 的 S05 脚本通过，API 31 项、浏览器 1 项，代码保持不变。
- `w5-existing-run.json`：原运行的只读状态核对。

## 尚未验证或交付

- 服务未部署，不能通知用户新代码已经在线。下一 Session 先做受控发布与真实飞书验证；当前 Session 不重启承载自身的飞书服务。
- W3 的原生 GitHub 关系仅覆盖读取及边界模拟，尚未做真实关系写入往返。生成 tickets 仍由 Matt 技能按项目 tracker 配置执行；平台新增部分是确定性导入及提审，没有另建自动发布器。
- 新路线仅开放已实测的 Codex / Kimi Code。其他 Harness，特别是旧业务路线中的 Pi / Antigravity，不得直接声称受限执行已验证；须独立实测或经批准调整配置。
- 模型认证只验证当前凭据和受控写入路径，未强制制造订阅令牌过期及长周期刷新。
- Issue 评论发送后缺乏回执时只对账，远端确实没有记录也不盲目重发；状态保留为待同步，需要核对。网络仍为共享网络，不是域名白名单。

## W5 的既有事实

- 原运行 `cmvb8eas90002snnifzn4a52f` 仍为 attention；S03/S04 passed，S05 已集成但尚未验收通过，R02A/R02B/S06 planned。核对时无活动的任务图 TaskRun。
- S05 提交为 `3350543d87911a7e7dcf5f1cea3812567aed349f`，原任务工作区保留。缺第二张不同的真实 P11/P12 照片及答案来源，不能用复用同图的测试记录冒充满足 Spec。
- mold 仓 `dev` 有未跟踪的 `contracts/hmi-reader/process-screen/`，本次未修改。其 Gitee Issues 列表当前为空，不能声称剩余业务 tickets 已导入。
- Reader 当前 `deploy/yizumi-auto-page` 有多项未提交修改，尚无 `docs/agents/issue-tracker.md`。本次未修改或清理。后续必须明确获批基线、tracker 与改动归属后再派发。
- 迁移必须保留 S03/S04 账本，不重跑；不能改写旧获批快照或自动放宽 S05 条件。如何将旧运行与 Issue 关系关联，还需要在 W5 中具体实施和验证。

## 下一 Session 的范围

先阅读本文件、Spec 和对应 Gitee Issue，核对分支及原工作目录状态。只处理一个可验收单元：优先安全合入、发布并验证已有平台改动，补齐未验证项后再讨论业务迁移。完成一个单元后记录结果并结束 Session；不依赖聊天上下文继续整条路线。

## 本分支修改文件

- `AGENTS.md`
- `docs/architecture/issue-route-packages.md`
- `docs/architecture/task-graph-workflow-spec.md`
- `docs/specs/workflow-convergence/README.md`
- `docs/specs/workflow-convergence/execution-status.md`
- `scripts/task-graph-propose.ts`
- `scripts/test-task-graph-postgres.mjs`
- `src/lib/acpx/runner-harness.ts`
- `src/lib/feishu-graph-picker.ts`
- `src/lib/feishu-live-room.ts`
- `src/lib/feishu-task-graph-command.ts`
- `src/lib/harness/adapters/codex.ts`
- `src/lib/harness/adapters/kimi-code.ts`
- `src/lib/harness/bubblewrap.ts`
- `src/lib/harness/sandbox-env.ts`
- `src/lib/harness/toolchain-paths.ts`
- `src/lib/harness/types.ts`
- `src/lib/live-room-delivery-execution.ts`
- `src/lib/live-room-members.ts`
- `src/lib/real-agents/codex-agent.ts`
- `src/lib/real-agents/codex-app-server.ts`
- `src/lib/real-agents/kimi-code-agent.ts`
- `src/lib/task-graph/card-actions.ts`
- `src/lib/task-graph/check-environment.ts`
- `src/lib/task-graph/check-runner.ts`
- `src/lib/task-graph/completed-workspaces.ts`
- `src/lib/task-graph/conversation-members.ts`
- `src/lib/task-graph/conversation-recovery.ts`
- `src/lib/task-graph/conversation-task.ts`
- `src/lib/task-graph/coordinator.ts`
- `src/lib/task-graph/dependency-paths.ts`
- `src/lib/task-graph/domain.ts`
- `src/lib/task-graph/feishu.ts`
- `src/lib/task-graph/git-command.ts`
- `src/lib/task-graph/harness-runtime.ts`
- `src/lib/task-graph/issue-dispatch.ts`
- `src/lib/task-graph/issue-route.ts`
- `src/lib/task-graph/issue-source.ts`
- `src/lib/task-graph/issue-sync.ts`
- `src/lib/task-graph/issue-tracker.ts`
- `src/lib/task-graph/launch.ts`
- `src/lib/task-graph/prompts.ts`
- `src/lib/task-graph/proposal-card.ts`
- `src/lib/task-graph/proposals.ts`
- `src/lib/task-graph/propose-spec.ts`
- `src/lib/task-graph/review-workspaces.ts`
- `src/lib/task-graph/role-configuration.ts`
- `src/lib/task-graph/spec-package.ts`
- `src/lib/task-graph/worktree.ts`
- `tests/task-graph-conversation.test.ts`
- `tests/task-graph-issue-execution.test.ts`
- `tests/task-graph-issue-proposal.test.ts`
- `tests/task-graph-issues.test.ts`
- `tests/task-graph-proposal.test.ts`
- `tests/task-graph-sandbox.test.ts`
- `tests/task-graph-workflow.test.ts`
