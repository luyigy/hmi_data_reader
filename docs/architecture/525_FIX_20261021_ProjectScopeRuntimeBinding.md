# Project Scope 与 Runtime 授权变更衔接

## 范围与基线

基线 `0cca17ca76fc9c7c6f52c183504a7e4b18b86567`。修复分支 `fix/project-scope-runtime-20261021`。
本轮只修改 Project Capabilities 与 Runtime 绑定之间的合同。未修改 Sandbox Manager、Bubblewrap 后端、跨仓输入保护、恢复预算或数据库 schema；未部署或恢复生产 Ticket。

## 现场与根因

R6_BOLE 的候选为 `e11cef054d1d68c894538e7195eb3233c62f12f1`。用户批准读取同表射出/保压字段后，宿主配置及 scope 回执已追加，但验收新 TaskRun 在模型启动前失败，错误为：

> 项目工具授权变化，原运行快照保留；须批准新的执行后重新固定

源码中两个消费者的解释不一致：

1. `context.ts` 只有原批准快照不存在 capabilities 时才读取迁移回执，已有范围的正常任务不能接受后续明确批准。
2. `runtime-continuity.ts` 的迁移判断要求 `!pin.projectPolicyHash`，只能兼容原快照没有授权哈希的旧任务，不能接受已有哈希的变更。

此前只验证资料接口，没有验证完整的验收启动链，导致发现问题过晚。M6_DEMAG 被 BOLE 未通过历史提交阻塞属于另一项输入保护，不在本轮删除或放宽。

## 文件与合同

- `src/lib/project-capabilities/scope-resolution.ts`：统一解析原范围、历史迁移及新批准的 scope change。校验仓库、执行、路线快照及当前宿主策略，资料访问与工具准备共用。
- `legacy-scope.ts`：已有 pin 哈希变化时追加 `project-scope-v2` 回执，绑定原哈希、claim、候选与 pin ID。沿用现有授权主体、Writer 退出证明、节点锁及归属复查。资料授权变更要求工具声明及只读挂载保持相同。历史回执不改写。
- `context.ts`：消费统一解析结果；原批准范围不阻止读取明确的新变更批准。当前主体授权检查保持有效。
- `tool-runtime.ts`：把同一授权依据交给 Runtime。
- `runtime-continuity.ts`：验证新批准确实连接当前 pin、原哈希、claim 及候选；工具声明、挂载、Python 身份、资源身份、源码和 CAS 继续检查。在原有事务内追加 `runtime_authorization_bound`，记录原 pin、批准、TaskRun、Stage、revision、候选和 Runtime 身份。原 pin 内容保持不变。

不采用“删除 hash 检查”或“所有旧回执都允许升级”。没有新批准时，宿主配置变更继续失败。旧版 scope 回执只用于原先的旧任务兼容，不覆盖原批准范围。v2 只覆盖已有可核验 Runtime pin 的资料授权衔接，不能用它更换运行工具或增加挂载。

## 验证与证据

机器入口已注册到默认 PostgreSQL 回归集合：

```bash
node scripts/test-task-graph-postgres.mjs project-capabilities-scope-change
node scripts/test-task-graph-postgres.mjs project-capabilities-scope-change project-capabilities-c01 project-capabilities-c02 task-graph-runtime-pinning task-graph-prepared-review
npx tsc --noEmit --pretty false
npm run check:long-files
```

所有数据库变更在 runner 创建的 `task_graph_test_*` 独立 schema 中，结束后删除；没有使用生产执行账本作为测试夹具。

### 红回归

保留新授权解析及测试夹具，将 `runtime-continuity.ts` 精确换回基线版本，运行同一新回归，确认失败包含上述实际错误。随后恢复修复版。证据 `docs/evidence/project-scope-runtime/red-original-runtime.log`。这是原 Runtime 检查的定点回放，不声称整个新方案在原始完整代码中已存在。

### 绿回归

`green-regressions.log` 保存联合回归输出；`green-scope.log` 保存最终新用例输出。

- 首次实施准备固定旧 pin；旧 pin 已有非空授权哈希。
- 未批准宿主配置改变时拒绝。
- 追加新批准后，原有 capabilities 的资料接口与 review Task 身份的验收准备均采用新范围。
- Runtime identity 与只读挂载不变；原 pin payload 完全相同。
- 真正运行 Bubblewrap：可读取候选源码，源码写入失败，批准的输出目录写入成功。
- 篡改原授权哈希、候选、claim、执行身份和 pin ID 均拒绝。
- 未批准目录扩张、批准尝试夹带挂载变化、撤销主体授权均拒绝。
- 原 Session 标识、claim、候选及四项预算计数保持原值。
- C01/C02、原 Runtime 固定、受控验收恢复回归通过。恢复预算耗尽的约束仍有效。

本轮执行了真实 Bubblewrap 与真实 PostgreSQL，但没有声称真实 Codex 模型或生产飞书验收已完成。现有测试证明 runtime 准备与资料接口衔接；部署后的原生 Codex、Topic 和独立验收仍须另行核验。

## 上线边界与残余风险

本轮为代码修复，不自动部署、不重置或恢复生产任务。上线时需要先核对生产 Writer 与当前 claim；已有旧版 scope 回执不会被修改，必须按新入口预览并追加 v2 批准。

伯乐之前的失败可能已消耗验收平台恢复预算。上线后必须读取实际账本，只使用已有受控修复机制，不能清零或放宽预算。无法满足现有恢复门禁时应明确报告，不能把本次代码通过解释为生产恢复成功。

M6_DEMAG 的跨仓输入检查保持原状。只有 BOLE 实际满足交付条件后才重新核验并接续，不把资料可读解释为验收通过。候选集成与可交付版本分离不在此次实现范围内。

## 2026-10-21 合并部署与真实 Codex 补验

用户随后明确授权合并、部署和测试。`8a15eee` 已 fast-forward 合入 oss-prep 并推送 Gitee、luyigy。隔离 worktree 的生产构建通过，生产协调器与任务进度服务已重载，HTTP `/api/health` 返回 200 healthy。飞书主运行时因承载当前会话，安排在所有活动 TaskRun 退出后空闲重载，完成结果写入 `output/deployments/scope-runtime/feishu-reload.json`；不能把“已安排”说成“已完成”。

真实 Codex 使用独立 PostgreSQL schema，在已获批 scope change 的 review Runtime 上通过原 JSON helper 和 Sandbox Manager 首次启动、续接同一原生 Session。两轮都用工具读取源码，实际返回 `readonly candidate`；来源文件未修改。Session、两个 Manager 进程与输出证据见 `deployment.json`。这不是原 BOLE 生产验收，也不是飞书 Topic 的端到端业务验收。

首次临时试验将 Codex Home 放在 `/tmp`，CLI 拒绝生成 helper aliases，模型虽启动却无法调用工具。该结果不计为通过。迁至实际部署磁盘目录后，要求两轮最终输出都包含工具读到的文件内容，才取得上述结果。原始启动结果保留在 ignored output，不覆盖失败证据。复跑原始 fixture 与 runner 记录在同目录的 `live-native-*.fixture.txt`，复制回 `output/deployments/scope-runtime/` 后以 `CODEX_HOME=/home/hello/.codex node output/deployments/scope-runtime/isolated-live-runner.mjs project-capabilities-scope-change` 执行。它使用本机既有模型凭据，不应在无授权环境盲目运行。CLI 的系统技能自动安装仍产生非致命只读目录告警，本次不宣称验证了全部技能安装功能。

生产 R6_BOLE 的 Writer 已退出，工具和挂载兼容，v2 授权批准已追加。但它的 platformAttempts=2、state=exhausted。调用既有 `registerPreparedReviewRecovery` 被拒绝，原因 `Recovery requires a different verified platform code measure`：原 pin 的 source 为 null，不能满足当前入口要求的旧平台代码来源证明。没有修改旧 pin、预算或恢复门禁来制造通过。M6_DEMAG 仍等待 BOLE 真正通过。下一步须单独处理该旧票的受控恢复证明衔接，不能将本次部署或隔离 smoke 解释为生产 Ticket 已恢复。
