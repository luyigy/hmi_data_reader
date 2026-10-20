# S01 验证记录

源码基线：`92b03b42251939406b210ea86b7bac8838b02fce`。日期：2026-10-20。

## 隔离与修改范围

只新增 [审计报告](../../architecture/507_REPORT_20261020_MattPstackS01.md) 和本目录的证据/分析工具。没有修改 `src/`、`scripts/`、Prisma、配置、运行状态或现有未提交材料，没有创建远端票据、发送消息、重启服务或续跑业务任务。

数据库测试使用仓库现有 `scripts/test-task-graph-postgres.mjs`。该脚本先验证回环 PostgreSQL 或本机容器，再创建唯一的 `task_graph_test_*` schema，将测试连接固定到该 schema，最后删除该 schema。测试用临时 Git 仓库/worktree、受控 Harness 和 tracker/飞书出站替身。C02 使用真实 Bubblewrap；本轮没有设置 `AP_CAPABILITY_BROWSER_PROBE=1`，因此不宣称重跑了宿主真实 Chrome 验收。

## 静态证据

```sh
node --check docs/evidence/matt-pstack-s01/analyze.cjs
node docs/evidence/matt-pstack-s01/analyze.cjs 92b03b4 > docs/evidence/matt-pstack-s01/structure.json
```

两项成功。工具内置的反例自检验证了 SCC 不吞入单向后继、显式 type-only 不计运行时语法边、导入别名及 Prisma 写字段识别。另用完整基线 SHA 再生成一次，与存档逐字节比较一致；核对 25 个 execution 写入候选，以及 runner/followup 两条相反的非类型导入确实存在。

生成器只调用只读 Git 命令读取固定提交，不导入应用，不查询数据库。方法限制随 `structure.json.methodology` 一起保存。它是审计工具，不是 S02 架构检查门禁，没有获批的禁止规则。

GitNexus 只调用 `list_repos`，返回索引提交 `05f493e4f2e5b09dcbeaed516231e1527881f1c3`、落后 176 提交，故不使用它判断当前调用关系。未更新共享索引。

## 实际回归

| 命令 | 结果与可支持的结论 |
| --- | --- |
| `npm run test:task-graph-workflow` | 退出码 0。模式、角色矩阵、父任务上下文、冻结 Spec 包通过。测试使用临时文件/Git，不是线上路线审批 |
| `npm run test:task-graph-postgres -- project-capabilities-c02 task-graph-interactive-conversation task-graph-issue-execution` | 退出码 1。C02 已输出通过；会话测试报 P2028 后脚本停止，Issue 测试未运行。不能将组合报告为全部通过 |
| `npm run test:task-graph-postgres -- task-graph-interactive-conversation` | 单独复跑退出码 1，同一 `conversation-followup.ts:78` 报 P2028。事务上限 5000 ms、已用 5823 ms，见 [conversation-retry.log](conversation-retry.log)。两次失败均未修改应用后再跑，不能认定为已修复或单次偶发 |
| `npm run test:task-graph-postgres -- task-graph-issue-execution` | 单独补跑退出码 1，`Graph did not reach expected state`。500 轮周期后夹具节点 A 为 passed，B 为 verifying，C 为 planned。日志见 [issue-execution.log](issue-execution.log)，仅省略测试 claimToken 值。未进一步判定停留原因，不能报告 Issue 完整执行链本轮通过 |

首次组合运行的完整原始输出保存在 [regression-initial.log](regression-initial.log)。故障发生在 `conversation-followup.ts:78` 的事务内读取，事务上限 5000 ms，报错时已经 5714 ms。本轮不修改应用超时，也没有证明它由某种特定系统负载导致。

## 文档检查与范围限制

- 开工长文件检查通过，没有达到 1000 行阻断阈值的文件。
- 尝试 `npm run workflow:validate -- --preflight docs/architecture/507_REPORT_20261020_MattPstackS01.md`，工具报告 `candidate is not a PLAN/HANDOVER workflow document`。这是旧校验器的适用范围限制，不能记为通过，也不为通过校验将 REPORT 伪装成 PLAN/HANDOVER。
- 改用 YAML 解析检查 `doc_type=REPORT`、`doc_status=completed`、终止动作 `none`；检查 Markdown 本地链接与源码行锚点范围，并执行 diff 空白检查。最终结果见本记录末段。
- 未运行完整测试集、TypeScript 全量检查、Next 构建、真实模型/真实飞书交互、线上服务健康探针或 Reader/Mold 业务验收。本次没有应用代码变更，不用隔离夹具替代生产验收。
- 未由第二个 Agent 或人工独立验收；本轮采用源码核对、生成器自检、固定提交重放和现有集成回归。S01 完成不表示所有运行时回归均通过。

## 最终检查

固定提交 AST 证据逐字节复现通过；25 个 execution 变更候选核对通过。REPORT 类型/状态按现有合同的允许值校验通过，终止动作为 none。两份 Markdown 共 47 个本地引用及源码行锚点范围检查通过。分析脚本语法检查和长文件守卫通过。

全量 `git diff --cached --check` 提示两处行尾空格，分别是两份会话失败日志中的原始 `PrismaClientKnownRequestError: ` 行；为保存原始失败字节，不改写日志。对报告、验证记录、分析脚本和 JSON 单独执行暂存差异空白检查通过。此例外不修改仓库空白规则。

本轮通过的是工作流静态回归、C02 夹具及文档/分析工具检查；会话回归两次失败，Issue 执行回归一次失败。没有因为失败而修改测试、放宽权限或调整重试预算；未继续扩大到运行时修复。
