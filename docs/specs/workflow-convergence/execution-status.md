# 实施检查点

记录时间：2026-10-17，Asia/Shanghai。当前事实汇总见 [本轮集中变更记录](change-record-20261017.md)。下文按时间追加，早期阶段的“未实施/待发布”不代表最新状态。

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

## W5：现有业务关联 Issues 的实施检查点

用户确认 S05 话题的 Codex / Kimi 已能正常回复，并授权推进 W5。本次只推进 W5 的来源关联单元；真实跨仓续跑尚未完成。

- 已发布父 Spec `luyi1678/mold-data-webpage-tool#IKMGQ4`，六张 Slice 为 S03 `IKMGQ5`、S04 `IKMGQ6`、S05 `IKMGQ9`、Reader R02A `IKMGQC`、R02B `IKMGQM`、S06 `IKMGQX`。六片真实串行依赖已从 Gitee 回读；未人为关闭单据。
- mold 的文档提交 `470bf95b` 登记 `existingRun` 关联配置和说明 HTML。Reader 的文档提交 `47ad710` 登记实际 tracker。仅合入这两份文档工作，Reader 原有未提交文件逐文件摘要和状态保持，mold 未跟踪 contracts 保留。两个临时文档 worktree 已安全移除。
- 平台增加现有运行关联提审及后台确认。关联事件与原快照分开存储，禁止通过关联标记另建运行。确认后，历史完成结果进入既有 Issue outbox；实施和验收 Prompt 获得准确 Issue 引用。
- 真实原运行已只读验证可准备关联，但尚无已批准的来源事件。生产 S03/S04 保持 passed，S05 attention，后继 planned。提审卡必须待新版接收服务加载后发送，实际发送以 `.runtime/w5-adoption/reload-receipt.json` 为准。
- 关联测试使用真实临时 PostgreSQL 和 Git，验证卡片回调、后台核对、漂移退回、重复确认、账本不变和只同步两张完成单；外部传输模拟。全回归还发现并修复清理回执的并发唯一键冲突，改用数据库 `ON CONFLICT DO NOTHING`。
- S05 尚缺第二张不同的伊之密 P12 熔胶页现场原图、机台页面信息及参数答案来源。已有重用同一原图的两条记录不能替代。原 API/双视口脚本通过不等于真实材料验收已通过。

本轮重载必须在当前会话退出且系统持续空闲后进行；不能在承载本会话的飞书服务内直接重启。独立 helper 核对 Git HEAD 和服务 PID，重载并验证健康后才发关联卡。卡片只关联，用户确认之前不启用来源、不恢复 S05。W5 Issue 继续开放。

下次从本节及部署回执接续，先核对来源关联是否实际确认，再看 S05 材料是否补齐；不要重做 S03/S04，也不要跳过 S05 直接启动 Reader。

### W5 本轮验证与交付边界

已通过 PostgreSQL 全套任务图回归、任务图工作流测试、TypeScript、变更 TS 文件 lint、长文件守卫及 diff 空白检查。实际 Gitee 提审准备也已验证，原业务账本没有变化。GitNexus 的 AP 索引因 LadybugDB shadow-page replay 不可用，本轮采用调用链追踪和真实边界回归，没有重建或删除索引。

空闲发布脚本为 `.runtime/w5-adoption/reload-after-idle.cjs`，入口 `run-reload.sh` 显式加载飞书独立服务所需环境。它在新版接收端健康后提出关联 V4，记录 proposalId、cardMessageId 并回读话题归属和标题；不确定发送不得盲目重发。`.runtime/w5-adoption/reload-receipt.json` 尚不存在时，不能说卡片已发送。

此前 W1–W4 的飞书重载实际上已健康运行；旧回执 attention 来自后续通知进程没有加载 Feishu 环境而失败，并非重载失败。本轮认证预检成功，真实用户问答已验证旧服务工作。不重跑旧 helper。

## W5 后续修复：S05 无法读取已发图片

- W5 来源关联卡已在新版接收端健康后发到科学试模父话题，proposal `cmvc7o11f0001vtj9dyhxd62y`、消息 `om_x100b620072ca50a8b4aa06f465cb0b7`，归属与标题回读通过。通知也已回读；发送不是人工确认，不据此恢复 S05。
- 2026-10-17 用户反馈子任务无法通过 lark-cli 看群中原图。真实问答日志显示沙箱没有 CLI 配置，返回 `not_configured`，并误用“工作流自动化”群 ID。宿主已有 bot 认证有效，无需要求用户重新登录。
- 图片实际上在 S05 话题，消息 `om_x100b6200d66a8cb0cf039dc937098a7`，时间 2026-10-17 18:10。群主线 API 未展开它；真实 thread 查询和资源下载成功，已打开原图确认可显示。它尚未被业务验收，不能继续说用户没有发图。
- 新增平台话题图片输入模块，绑定来源校验、分页、原消息索引、哈希、独立只读挂载；问答和恢复验收都读取同一来源。不把全部飞书凭据暴露给模型，也不将图片取得等同验收通过。
- 原图 SHA-256 `6ae209d5e7047dd8fc4892646a308d1b37179196105fdf185696fdfb35d36c7b`。真实 S05 Bubblewrap 探针已验证可读、不可写、Feishu CLI 配置仍隐藏；原执行与节点前后逐字段相等。原图索引及探针回执在 `.runtime/s05-topic-material-receipt.json`。
- 自动回归使用真实临时 PostgreSQL、真实 Bubblewrap、外部飞书传输模拟，检查实际问答 Prompt、验收任务挂载、错误群归属拒绝、重复取得不重复材料，以及无执行状态变更。GitNexus 本轮仍因 LadybugDB 只读 replay 错误不可用；用实际调用路径和边界回归核对，未重建索引。

本次发布以 `.runtime/s05-topic-materials-deploy/reload-receipt.json` 为准；当前会话结束并空闲后重载飞书接收端。不得在新代码实际加载前声称子话题已能读图。用户可以在原 S05 话题请求只读查看已有图片；是否满足 Spec、参数真值和正式验收仍应独立判断。

## W5 后续修复：验收输出误触发权限卡

用户在 S05 恢复验收后看到只有“拒绝”的权限卡。生产运行 `cmvcb8i7n02iovltn937jhz1t` 已于 2026-10-17T11:29:45Z completed，两条交互均 cancelled；父节点仍 attention，最终卡片也已刷新为 completed，不在等待人的批准。

根因是通用 stdout/stderr 启发式把 JUnit XML 中的 `permission` 测试名与 XML 的 `?` 当成权限请求，又把“验收复核报告（只读）”当成 workspace_issue。伪请求的 resumeStrategy 为 rerun_continuation，Kimi 不支持这种原进程批准，因此 UI 正确隐藏批准按钮，却把错误识别本身暴露给用户。

修复使 Codex / Kimi Code / Antigravity 的普通输出不参与终端提示猜测；真正的 Codex 原生请求继续通过独立 onInteractionRequest 事件。回归在真实隔离 PostgreSQL 中调用实际 executeParticipant 的 stdout/stderr 回调，Harness 执行边界模拟；修复前复现两条伪请求，修复后没有交互记录，正常输出与参与者完成状态保留。另行验证原生 Codex 权限和生命周期、飞书权限卡边界，未增加虚假的批准能力或提高沙箱权限。

业务边界：新图已取得且与旧图不同，但本次复核确认它尚未走完整业务链路。误报修复不等于 S05 通过，也不重复 resume 或重新实施。真实材料、实际补验与权限误报应分别记录。发布回执在 `.runtime/s05-false-approval-deploy/reload-receipt.json`，须待本会话退出和系统空闲再重载飞书接收端。

## 任务图输出布局调整

用户要求执行输出沿用普通话题的呈现方式。任务图进度卡只展示状态，系统信息和工具调用分别放入默认收起的折叠区；Agent 的完整段落与最终回复各自使用独立卡片，不在进度卡重复正文。保留原回复 UUID、游标、并发锁、脱敏和权限操作。结束的运行不再显示待处理按钮。

针对 PostgreSQL 飞书转发边界验证分区、正文独立卡片、连续 token 拼段、并发轮询不重复发、失败游标保持与最终回报不重复。旧断言要求正文和技术事件在同卡，已按用户要求改为检查相互隔离。TypeScript、变更文件 lint 和长文件守卫通过。GitNexus 仍因 LadybugDB 只读 replay 不可用，用调用路径核对：本次只影响独立 `agent-platform-task-graph-feishu.service`，不需要重启承载聊天的飞书接收服务或重新执行业务任务。

发布后将原 S05 已结束运行的现有进度卡刷新为新布局，不重发历史正文、不修改验收状态。投递及服务加载结果保存在 `.runtime/graph-output-layout-deployment.json`；完整正文仍留在执行账本，卡片只展示受限长度预览。

## 已批准的接续体验修复

用户认可 Antigravity 在 2026-10-17T12:19:55Z 的四点审查，并授权实施。本次实现自然语言接续、父子话题图片归集、可写验收运行目录和最多两轮的范围内自动回修，不再要求搬图、切话题或补敲命令。

- 明确“继续验收”直接进入经过鉴权的持久化请求；上下文口语可由 Agent 控制块交平台核验。原用户身份来自入站元数据，模型不能冒充。并行目标歧义只问一次，回复代号可接续；取消或超时后不再使用旧选择。
- 验收使用可写运行目录，原代码、元数据、工具链和图片只读。没有新增验证 worktree，保持同任务的实施代码与证据来源；较审查建议的“源码可写再做 Git 检查”采用更强的文件系统保护。架构和普通问答仍只读。
- 结构化范围内缺陷自动排回原实施者，复用工作区、最新基线及固定分工。修复后重新集成与验收；架构结果按提交组合缓存。旧领取与派发状态会阻止新轮次，已补齐释放和追加历史记录，未改写获批快照。
- 真实临时 PostgreSQL 的入站 Feishu 路径验证父话题一句话接续、消息重放去重、鉴权、问题与否定不触发、歧义选择与取消。图片测试覆盖父子归集。真实 Git/Bubblewrap 协调器测试覆盖独立支线通过、补验发现范围内缺陷、自动回修并再次验收、汇合继承正确提交；已完成支线不重跑。上限两轮和缺材料不自动实施也有回归。
- 真实 S05 运行态探针验证了临时 SQLite 写入/读回、临时 HTTP 服务、源码与实际新图不可写、Feishu 配置不可见。探针回执 `.runtime/continuation-s05-runtime-probe.json`；业务节点逐字段保持，不把探针当业务验收通过。
- 原 S05 新图仍为 `6ae209d5…`，无需用户重发。发布后从用户原先明确“用后发图片验收”的原消息接续一次，须先通过 Feishu GET 验证原发言者及话题，复用消息幂等键。请求登记、服务状态和后续运行以 `.runtime/continuation-deploy/reload-receipt.json` 为准。不能把登记请求写成验收通过。

GitNexus 仍受 LadybugDB 只读 replay 故障影响；未重建索引，用调用链和真实边界回归核验。旧业务未提交代码不属于本次平台改动。W5 继续开放，实际新图、Reader 接力和 S06 必须看真实运行结果。


## R02A 后续修复：平台复验无法导入任务依赖

2026-10-17 R02A 实施 TaskRun `cmvcffpoh0184d9ozdv2eb9n4` 已完成；暂停发生在受控提交后的集成检查，尚未进入独立验收。原检查 `env PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q tests/test_r02_extractor_registry.py tests/test_contract.py` 在真实工作区稳定复现 `ModuleNotFoundError: No module named cv2`。实施者已将 OpenCV 与 multipart 装入本任务私有 HOME 的用户包目录；平台检查把 HOME 改为 /tmp，既未挂载包目录也未设置 Python 搜索路径，导致同一命令的环境不同。

修复只把原实施任务的 Python site-packages 只读挂载给平台复验与独立验收，不挂载其认证目录，不改共享 Python 或源码。自动检查保留批准 argv，按服务端 childTaskId 定位依赖；验收 Prompt 给出同一依赖路径。原真实 R02A 检查在修复后已通过 44 项测试和 22 项子测试。真实 sandbox 回归覆盖同任务可导入、不同任务不可导入、依赖不可写和凭据不可见。

跨仓 Spec 路径不可读也属实，新增按批准包 hash 校验并从冻结 commit 导出的只读附件副本，Prompt 明确副本位置，不能把当前工作副本当成批准版本。Reader 的项目 verify skill 实际不存在；缺少可选 skill 时按 ticket 明确入口验证并报告，不伪造 skill 已加载。失败报告保留批准命令、退出码和实际 stdout/stderr，移除冗长 Bubblewrap 启动参数。独立回归覆盖冻结副本不受原仓未批准修改影响及失败可读性。

本次不重新实施 R02A、不跳过测试或验收、不改角色与依赖、不触碰 Reader 主检出的已有改动。恢复时先核对原 TaskRun 已结束、工作树干净、受控提交与基线，复用同一工作区重做集成检查，通过后交原验收者继续；实际恢复和服务加载以 `.runtime/r02a-diagnosis/recovery-receipt.json` 为准。44 项测试通过不代表 R02A 已获独立验收通过。

本轮 TypeScript、变更文件 lint、完整任务图 PostgreSQL 套件、长文件守卫通过。GitNexus impact 仍返回 LadybugDB 只读 shadow-page replay 故障，风险为 UNKNOWN；未重建索引，已按实际 runChecks 两个调用点与沙箱边界回归核对。真实批准 Spec 副本已在 R02A 沙箱内验证可读。

## 项目既有环境复用

用户明确要求默认使用项目已有虚拟环境，不为每个任务另建和下载。本轮按该要求替代 `ccf7973` 的私有 HOME 包扫描：源仓 `.venv` 默认或源仓配置的既有环境只读挂载，统一在 Bubblewrap 启动入口注入工具路径、VIRTUAL_ENV 和禁用用户包设置；实施、检查、验收共享同一选择，Harness 认证隔离。没有新增环境创建/安装步骤。验收涉及多个不同 Python 环境时拒绝隐式混用。

真实 Reader 三阶段探针均使用 `/data1/code/hmi_data_reader/.venv/bin/python3`，Python 3.10.12、OpenCV 4.6.0；原 R02A 固定提交在该项目环境跑出 44 passed、22 subtests passed。探针及检查分别在 `.runtime/r02a-diagnosis/project-env-probe.json` 和 `project-env-r02a-check.json`，临时验证检出已移除，未改 Reader 主检出的已有内容。

回归先复现未选项目环境导致导入失败，再验证真实 linked worktree 的实施 shell、平台检查、独立验收目录使用同一环境；覆盖依赖只读、凭据不可见、既有解释器符号链接、显式配置错误不回退、任务不创建 .venv。完整任务图 PostgreSQL 套件、TypeScript、lint、长文件守卫通过。GitNexus 对共享启动器的 impact 仍为 LadybugDB 故障/UNKNOWN，未重建，已按实际调用点及边界回归核对。

项目环境属于项目，不随任务清理删除。宿主外部变更环境仍需协调；本轮不引入逐任务环境快照或容器。当前业务图 S03/S04/S05/R02A/R02B 已通过，S06 为仅实施交付（delivered_unverified），不能说 S06 完成了独立验收。此次环境改造不重跑或修改这些业务状态。部署回执 `.runtime/project-env-deploy/reload-receipt.json`；需服务空闲加载后才生效。

## 发布结果归档

`7cd673a` 发布回执已 verified，2026-10-17 22:29:15 +08:00 确认协调器和飞书接收端已加载，transport healthy，通知回读通过。当前业务图 S03/S04/S05/R02A/R02B passed，S06 delivered_unverified。此次文档归档不派发任务、不重新执行验收。集中记录见 `change-record-20261017.md`，其中明确私有包扫描已被项目环境复用替代，以及验收运行目录归档清理仍待处理。

## 验收运行目录归档清理与 S06 定位

用户授权补齐临时验收目录归档清理，并要求先解释 S06 找不到 Reader。查阅真实 TaskRun `cmvchfru801klerlet4wg2ya7`：S06 在 mold 工作区执行，明确报告 Reader 路径只有 `.agents`，无法读取 R02A/R02B 提交及 HTTP/CLI 合同，同时还缺少冻结后新页实图和答案来源等材料。Reader 两片在账本已 passed，提交 `c5aa25a…` / `982ef2d…` 保留在 Reader 集成分支，临时 worktree 按既有策略删除。派发只处理前置放行，没有提供前置仓库的固定提交源码输入，故为跨仓输入缺口；不是代码丢失，也不应把 S06 工作目录切换到 Reader。本轮不修改业务状态、不将该缺口标为已修复。

新增验收归档模块：节点完成且没有活跃会话、工作树清理完成后，归档全部验收轮次，逐文件 SHA-256 与大小核验，再检查源内容和会话状态，最后只删除对应节点的临时验收目录。常见缓存不归档，符号链接/特殊文件/过量/变化/损坏均保留现场并记 deferred。清理是幂等的，旧 worktree 已清理的节点仍可补扫验收目录。归档目录与 manifest 写入账本，子话题问答可只读查看，避免旧报告路径失效后无法定位。

回归覆盖临时 PostgreSQL 的完成状态、并发清理、活跃任务、脏工作区、旧节点补扫、归档访问归属，真实文件系统覆盖多轮报告、缓存、归档校验、中断重试、损坏、符号链接和途中变化。完整任务图 PostgreSQL 套件、类型、lint、长文件检查通过。GitNexus impact 仍因 LadybugDB 现有 replay 故障返回 UNKNOWN，未重建索引。规范见 `docs/architecture/validation-result-lifecycle.md`。实际补清与服务加载证据在 `.runtime/cleanup-review/`，须按回执区分已执行与待发布。
