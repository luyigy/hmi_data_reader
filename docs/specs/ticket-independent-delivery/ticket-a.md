<!-- ap-publish:ticket-independent-delivery-20261023:S02_A -->
<!-- ap-ticket-v1 {"version":1,"project":"ticket-independent-delivery-20261023","sliceKey":"S02_A","parent":"gitee:luyi1678/agent-platform-v2#IKQ2GA","blockedBy":[]} -->

# [S02_A] 独立交付规则落地

Parent: https://gitee.com/luyi1678/agent-platform-v2/issues/IKQ2GA
Blocked by: 无前置实施票。

## 独立目标

后续提审默认把可独立验收目标各自建为 Ticket/Node；单执行 Agent 在实施中自查并提交正式结论。规范、示例、提示和必要回归一起完成，不靠删除安全条件制造独立交付。

## 允许修改

- docs/agents/issue-tracker.md：票据独立目标、输入/验证方法、完成标准和真实前置；真正联合例外的正文要求。
- docs/architecture/issue-route-packages.md：独立 IA/IB、ID 依赖 IA、IC 依赖 IA+IB 的提审示例，以及不可拆分多 Execution 例外。
- src/lib/task-graph/coordinator.ts 的既有任务描述/qualityInstructions（基线约 138、553–556 行），src/lib/task-graph/prompts.ts 的实施责任说明：单执行当轮自查；多执行仅已批准联合目标才提示组合；Tester、人审和旧合同语义明确。
- tests/task-graph-ticket-independent.test.ts（可新建）、现有直接相关 tests/task-graph-agent-owned-quality.test.ts、tests/task-graph-workflow.test.ts；scripts/test-task-graph-postgres.mjs 仅登记新增隔离回归。必要时更新本包验收说明，不新增运行期机制。

不得改 implementation-quality.ts 的全本票版本绑定、store.ts 的全部集成条件、Prisma/状态枚举、旧批准合同、运行恢复机制。若真实缺陷需要越出以上边界，记录反例和影响并回提范围，不自行拓展。

## 验证方法与完成标准

1. 新独立性隔离回归必须走真实 Git + 隔离 PostgreSQL + 现有协调器，不直接写 passed：IA/IB 独立，ID 只依赖 IA，IC 依赖 IA+IB；IB 尚活动/阻塞时 IA 正式 passed，ID 可释放，IC 不释放；IB 通过后 IC 只释放一次；IC 失败阻止其后继且不撤销 IA/IB。
2. 单执行实际提示没有等兄弟的误导；无代码/证据变化且第一次回执合法时只实施一轮。集成改树、缺证据/换版仍走现有原 Session 补验。联合目标完整绑定、缺执行/缺版本拒绝及换版失效不退化。
3. 对 Tester、人审、回修后重新验证、格式纠错原 Session、Git 冲突/CAS、legacy 和 delivered_unverified 的既有语义跑对应回归。正确行为不人为制造红测；确有缺陷则先保存真实失败断言。
4. 运行 npm run test:task-graph-postgres -- task-graph-ticket-independent task-graph-agent-owned-quality task-graph-result-recollection task-graph-conflict-repair task-graph-review-repair task-graph-issues task-graph-issue-proposal；另运行 npm run test:task-graph-workflow、npm run check:long-files、git diff --check。只使用 scratch schema，不在 public 上测试。
5. 未参与实现的独立 Tester 检查固定提交、实际回归、规范/示例和 Diff：无新机制、无降级旧条件、与本票及 541 限定范围一致。实施自查不能代替独立审查。

## 执行约束与交付

主仓 /data1/code/agent-platform-v2，原生 Codex；一个 Node/Execution，现有 lean 模式 + 独立 Kimi Code Tester。无 extra repo，测试在现有隔离目录。以路线卡冻结 SHA 为准。按 pstack 小改动配对应验证，追加提交。不得部署/重启/修改生产账本或恢复 Reader/Mold；保留用户本地 541 和两个 skill 修改。完整设计与边界见固定 Spec 包 spec.md；报告固定 SHA、文件、命令输出、未测项及独立结论。通过 A 只代表规则及隔离回归交付，不代表 B 真实验收完成。
