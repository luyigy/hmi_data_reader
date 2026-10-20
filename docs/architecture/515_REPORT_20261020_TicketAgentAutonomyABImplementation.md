---
doc_type: REPORT
doc_status: verification_pending
---

# Ticket Agent 自主性 A/B 实施记录

范围以 [514 合同](514_ARCH_20261020_TicketAgentAutonomyABContract.md) 为准。基线 `bbc574d`，独立 worktree `/data1/code/agent-platform-ticket-autonomy`，分支 `feat/ticket-agent-autonomy-ab`。

A 已提交为 `0b316f2`。B 与本文在后续独立提交中记录。主工作区未合入，生产服务未重启，现有 Ticket 及账本未改写。真实 Codex + 飞书 Topic 尚未验收，不能把下列隔离回归当成该项完成。

## A 做了什么

原来的技能目录挂载只包含安装入口，严格沙箱无法读取入口 symlink 指向的实际包。现在沿用现有 RuntimeDeclaration，为技能声明精确包根、摘要、必需文件及包内检查脚本。宿主必须明确授权该包根，仓内声明无法自授权限。

预检在真实严格 Bubblewrap 中读取完整包并运行固定脚本，确认映射、playbook 和项目适配；检查失败发生在模型启动前。原 claim 的资源 pin 继续固定身份，Harness 启动前再次核对摘要。没有递归放行链接，也没有开放整个 HOME。

变更文件：`runtime-contract.ts`、`runtime-preflight.ts`、新 `skill-resource-preflight.ts`、`runtime-continuity.ts`、`acpx/runner-harness.ts`。测试为新 `task-graph-skill-runtime` 和扩展的 `task-graph-runtime-pinning`，由原临时 PostgreSQL runner 登记。

[A 的命令和边界](../evidence/ticket-agent-autonomy/ab/a-verification.md)、[红日志](../evidence/ticket-agent-autonomy/ab/a-red.log)、[绿日志](../evidence/ticket-agent-autonomy/ab/a-green.log) 已保存。真实已安装 poteto-mode 的检查脚本在 Bubblewrap 中成功运行；模型调用数为 0 的失败场景通过。旧 browser/OCR、权限及固定资源回归通过。

## B 做了什么

新产生的实施期普通材料等待使用现有 `waiting_for_user`。下一条有效输入经原 Inbox、Coordinator 回到同一个实施 worktree 和 native session，不创建只读中转，也不需要恢复控制行。

普通成功回答不再因为没有正式交付结论而消耗格式补收预算。只有明确的正式交付结果才能集成及放行后继；空结果、损坏的结构化结论、真正失败的 TaskRun 仍按原错误处理。结论补收和冲突处理不采用普通回答的解释。

接续检查仍在原入口内：当前阶段、依赖、候选、归属、输入来源及 Writer 退出证明必须匹配。慢退出观察在事务外，锁内重核 P0 身份快照、pending 输入及原 revision。接续追加 `conversation_turn_scheduled` 证据事件，再由原 TaskRun 输入绑定消费；没有新增恢复状态或预算。恢复投递不确定的输入时，授权沿用同 execution 的原始输入来源，不把恢复包装文本误作身份变化。

环境缺失、上游绑定、范围或权限决定、验收阶段、Writer unknown/alive、已交付和 exhausted 都不会因普通消息重新开放实施。合法最后一轮计数等于上限也不会被误判为所有类别 exhausted。接续保留全部原计数。

历史材料暂停、旧 Followup 及 TASK_GRAPH_CONVERSATION 继续通过原 adapter 处理。已交付及受保护阶段保留只读会话。删除了 `prompts.ts` 中两段内部接力/普通会话协议说明，没有补充新的提示规则。

B 变更文件：`conversation-inbox.ts`、`implementation-result.ts`、`coordinator.ts`、`restart-recovery.ts`、`conversation-followup.ts`、`prompts.ts`。未修改数据库 schema、Session 归属接口、原生 Harness 权威校验或 claim 预算定义。

## 隔离回归与证据

全部命令使用 `node scripts/test-task-graph-postgres.mjs <suite...>`，每次使用并清理独立 `task_graph_test_*` schema，不写 public。

| 验证 | 结果与证据 |
| --- | --- |
| 新材料等待的红绿 | 旧源码落入 `waiting_decision` 而失败，修复后原实施连续交互通过。[红日志](../evidence/ticket-agent-autonomy/ab/b-red.log)、[实际状态/Session/工作区](../evidence/ticket-agent-autonomy/ab/b-continuation.json) |
| 领取保护的红绿 | 旧检查会把 check 阶段重新排到实施；修复后 27 个资格场景通过，含真正 Topic 来源、恢复输入、跨话题、重复输入、revision/候选竞态和原计数。[旧失败](../evidence/ticket-agent-autonomy/ab/b-guards-red.log)、[逐项状态](../evidence/ticket-agent-autonomy/ab/b-eligibility-final.log) |
| 正常及历史对话 | `task-graph-interactive-conversation` 通过，[同 session 三轮](../evidence/ticket-agent-autonomy/ab/b-green.log)、双仓并行、后继放行、旧材料握手和已交付只读均保留。主场景不产生只读中转或恢复控制输出 |
| P0 / Issue / 清理 | `task-graph-p0-timeout`、`task-graph-p0-reservation`、`task-graph-issue-execution`、`task-graph-completed-workspaces` 通过。[日志](../evidence/ticket-agent-autonomy/ab/b-compatibility.log) |
| 投递、预算、旧恢复 | `task-graph-conversation-delivery`、`task-graph-execution-progress`、`task-graph-implementation-recovery` 通过。[日志](../evidence/ticket-agent-autonomy/ab/b-boundaries-final.log) |
| 重启 | `task-graph-restart-recovery`、`task-graph-review-restart`、`task-graph-restart-ancestry`、`task-graph-integrated-restart` 通过。真实退出后接管，已集成结果不重做实施。[退出/阶段恢复日志](../evidence/ticket-agent-autonomy/ab/b-restart-preentry.log)、[复核/合流日志](../evidence/ticket-agent-autonomy/ab/b-restart-final.log) |
| 静态门禁 | `npx tsc --noEmit --incremental false`、`npm run check:long-files`、`git diff --check` 通过 |

重启回归发现两份基线夹具把 supervisor PID 改成不存在的数，却保留不匹配的 ancestry。相同失败也在原 `bbc574d` 复现，证据见 [review 基线](../evidence/ticket-agent-autonomy/ab/b-review-baseline.log)、[ancestry 基线](../evidence/ticket-agent-autonomy/ab/b-ancestry-baseline.log)。现改用共享测试夹具生成真实子进程身份并等待退出。没有放宽 Writer 解析或退出判定。

## 真实验收还缺什么

上述 Coordinator 测试替换了模型 adapter，虽使用真实 Git/DB/进程及 Bubblewrap，仍不代表真实 Codex 交互通过。

正式验收需要专用测试仓库、隔离数据库、可收到回调的飞书测试 Topic，以及按 AGENTS.md 要求确认的路线卡。当前卡片处理器与消息处理器注册在同一飞书连接中；`handleGraphProposalCardAction` 从本进程数据库读取 proposal，确认后直接创建并放行运行。不能把隔离 schema 中的卡片交给生产回调，也不能直接在生产库造测试批准记录或另开同 bot 的竞争事件连接。

可选部署安排须先确认：使用独立测试应用/回调环境运行隔离验收，或明确授权部署后在新测试 Ticket 上验收。部署授权和卡片批准都不能用测试替身伪造。现有生产 Ticket 不作为试验，也不自动恢复。

测试路线只需两个纵向节点：第一个实现一个依赖 Topic 中尺寸/颜色材料的小功能，经历正常问题、补材料和纠正，实际运行检查并修复范围内缺陷后正式交付；第二个在独立验收通过后使用该交付生成结果。验收保存真实 Topic/message ID、原生 session、claim/revision、writer 退出、资源摘要、输入 receipt 和预算前后值。完成交付后补一个只读问答，确认不会再开放源码。

## 仍需注意

- 尚未给生产项目添加技能声明或宿主授权。获批快照没有该授权时仍应拒绝，不会因代码上线自动补权。
- 包内容按摘要核对，未将可变宿主目录变成不可变文件系统；宿主维护者应保留固定包版本，不能在一次 attempt 中原地更新。
- 本次减少了普通澄清的中转；旧 adapter 未删除，待历史运行有迁移证据后再讨论清理。
- 适合永久保留的接口是“已授权运行资源的预检回执”和“基于 Writer/claim/revision 的原 Inbox 领取”。没有另建总状态机、权限来源或 Prompt 路由层。
