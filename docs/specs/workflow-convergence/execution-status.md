# 实施检查点

记录时间：2026-10-17，Asia/Shanghai。最新发布记录见本文末尾。

上轮要求拆成独立 Session，已在 W4 收尾后停止。随后用户明确授权利用当前 Session 剩余上下文继续发布验证，本轮仍不推进 W5。本文件记录当前事实，不触发 watcher 或任务派发。

## 代码位置

- 集成分支：`feat/workflow-convergence-20261017`。
- 工作目录：`/data1/code/agent-platform-v2-workflow-convergence`。
- 比较基线：`0374187`。
- 已将代码快进合入 `/data1/code/agent-platform-v2` 的 `oss-prep`；未推送远端。任务图服务已重启加载新版，飞书接收服务的空闲重载及最终结果参见下方发布记录。
- 原工作目录的六个卡片改动已逐文件核对、保存补丁和摘要，并随 `282ad8c` 保留在提交历史中。其余未跟踪资料未修改。补丁在 `.runtime/deploy-workflow-convergence/preserved-card-changes.patch`，不应用它重复叠加已合入的改动。

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

- 任务图服务已加载新版；当前 Codex 进程位于飞书接收服务的进程组，不能在回复前直接重启。空闲重载由独立 user unit 执行，须回读运行回执，不能把“已安排”说成“已完成”。
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

## 本轮发布记录

用户在上轮收尾后明确要求直接开始发布验证。本轮完成范围如下：

- `oss-prep` 已从 `0374187` 快进到含 W1–W4 和检查点的提交，追加历史，没有 amend/rebase/reset。六个既有卡片改动全部保留；其余未跟踪文件未改。
- 原运行再次核对：S03/S04 passed，S05 attention，后继仍 planned；没有启动、重试或放行 S05。未接入 Reader 或修改其工作区。
- 空闲的 `agent-platform-task-graph.service` 已于 2026-10-17 17:17 重启，MainPID 从 1009167 变为 1724446，启动日志正常。
- S05 子房间 `cmvbvm92b00h3fn65z5wgfbpq` 从仅有人类成员补齐为含获批 Codex 实施者和 Kimi Code 验收者。重复补齐不重复建成员。此动作只修复对话成员，没有启动 Harness。
- 原工作目录再次通过 `test:task-graph-workflow` 和 `tsc --noEmit`。只合入已验证代码及本发布记录，没有新增业务实施。
- 在当前私聊真实发送一张现有业务路线的只读预览，消息 `om_x100b62079afc54accfbdf7a6d5759f1`，位置回读为 `oc_b634823504e29e6220de0cfb5108a216`，标题正确且未删除。未创建待审批记录；卡片没有启动或确认按钮。
- 飞书 IM GET 对 Card 2.0 返回兼容回退内容，未暴露完整正文。因此只验证了真实投递、位置和标题，客户端视觉表现仍待用户查看；没有重复发送或声称已验证全部内容。

### 飞书接收服务重载

当前会话位于 `agent-platform-feishu.service` 的 cgroup。独立服务 `ap-workflow-convergence-reload-20261017` 将等待当前 Codex 退出、TaskRun 和任务图工作空闲，再连续保持 10 秒空闲；核对 Git HEAD、跟踪文件与原服务 PID 后，只重启飞书接收服务。最长等待 30 分钟，条件不满足便记录需处理，不强行终止任务。

脚本在 `.runtime/deploy-workflow-convergence/reload-after-idle.cjs`，部署清单在同目录 `deployment-manifest.json`。实际结果以 `reload-receipt.json` 为准：

- `waiting_for_idle`：尚未重启。
- `healthy` 且 `notificationStatus: verified`：新 standalone PID、运行状态和健康连接已核验，通知已在当前私聊预览卡下回读。
- `attention`：查看 `error`；不能声称已完成重载。消息发送结果不确定时不盲目重发。

该脚本不创建 Spec/tickets，不确认路线，不恢复或放行任何业务节点。重新运行前先检查回执，避免重复重启或重复通知。

### 下一步真实验证

先读上述重载回执及服务状态，确认新服务健康。用户回到 S05 话题询问“当前还缺什么验收材料？只回答状态，不重新实施”，观察实际 Harness 回复，并核对只读问答 TaskRun 与原执行状态未改变。这里尚未伪造用户提问或代替用户完成客户端点击验收。

当前平台 Spec 尚无 ready 的 Issue-backed 提审包；科学试模的旧包仍是历史 route.json。新菜单不会将旧包冒充为新 Issue 路线。这部分准备与业务迁移需继续 W3 未验收项或 W5 的对应单元，本轮没有偷偷改写旧包和已获批快照。
