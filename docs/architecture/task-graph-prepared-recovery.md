# 平台准备完成后的自动接续

S01 为已批准任务图增加一个窄入口。运维完成上游绑定或缺失运行能力的准备后，登记带证据的回执。现有协调器消费回执，并调用原来的受控恢复函数。登记操作本身不把任务改为 ready。

## 使用方式

本机 CLI 与 `task-graph:doctor` 使用相同的操作系统及数据库权限。它不是远程免认证接口，也不把 Agent 文本当作授权。

先完成实际准备和校验。再读取当前暂停的绑定摘要：

```bash
npm run task-graph:prepare-recovery -- --run-id <Run> --node-key <Slice> --remediation upstream_binding
```

返回的 `bindingHash` 绑定当前获批快照、单个 execution、revision、原 claim、TaskRun、失败详情与指纹、候选和原始基线、原工作区以及已完成依赖的集成提交。任何一项改变都会使旧回执失效。

运维编写 JSON 回执。下面是格式示例，其中标识和哈希必须替换成实际值：

```json
{
  "version": 1,
  "runId": "实际Run",
  "nodeKey": "实际Slice",
  "requestId": "唯一准备请求标识",
  "authorization": "用户授权或运维变更记录标识",
  "changeReason": "具体修复了什么，在哪个日志中验证",
  "readiness": "local_operator_attested",
  "remediation": "upstream_binding",
  "bindingHash": "当前暂停绑定的64位SHA256",
  "artifacts": [
    { "path": "/绝对路径/实际校验日志", "sha256": "文件字节的64位SHA256" }
  ]
}
```

登记回执：

```bash
npm run task-graph:prepare-recovery -- --receipt /绝对路径/准备回执.json
```

这是一份本机运维对准备完成的证明。平台验证身份绑定和文件字节，不会独立证明日志里的业务断言为真。运维仍须实际核验准备成果。

回执的文件引用是补充材料。恢复事件会把这些引用带入原任务的接续说明，不替换获批的上游提交、合同或验收要求。登记不会提交、重置、清理或删除工作区。

## 接续边界

当前仅支持一个 execution 的节点。节点必须处于实施阶段的 `attention / waiting_decision`，并有原归属、候选和工作基线。

允许的失败只有：

- `missing_upstream_input`，对应 `upstream_binding`。
- `environment_failed` 且持久化 `blockerCause=missing_capability`，对应 `missing_capability`。历史记录未保存原因时不能从自由文本猜测。

两类都必须由平台负责且不需要用户业务决定。缺业务材料、权限变更、范围变化、所有权未知、冲突处理和耗尽状态都不能通过此入口跳过。已用完某个无关计数器不会阻止当前准备恢复；全部计数器保持原值，后续阶段仍按原额度执行。

消费时在原节点锁及恢复事务内重新验证当前绑定和文件。随后由原恢复函数核对真实写入者退出、活动 TaskRun、未完成合并和当前状态，再生成原有恢复事件。不会另建调度器。

回执登记、消费结果都是追加事件。同一个请求重复登记相同内容返回原事件，不同内容报错。若服务在恢复成功后、消费记录落库前退出，下次会取得同一恢复回执，不会重复派发。旧回执不能重新放行后来的暂停。

可确定的拒绝会记录具体原因，保留原现场。未知基础设施错误保留待消费回执，下次周期再试；协调器记录带 Run 标识的错误并继续其他独立工作。再次准备须用新的请求标识。

## 验证与限制

`npm run test:task-graph-postgres -- task-graph-preparation-recovery task-graph-environment-outcome task-graph-lifecycle-adapters` 使用独立测试 schema，覆盖自动接续、重复及崩溃回放、锁内过期绑定、活跃及未知写入者、耗尽状态、无关预算、业务失败、未完成依赖、文件篡改和符号链接。

证据在 `docs/evidence/m02-s01/`。红色记录是禁用消费函数后的受控变异，重现登记后仍停在 attention 的旧行为，不是历史提交二分测试。绿色记录恢复真实消费函数后运行相同测试并通过。

GitNexus 影响分析因 LadybugDB 影子回放只读不可用，影响风险记为未知。没有重建共享索引。源码导航核对原恢复调用者及本次差异，保留原 doctor 和人工恢复调用行为。

这个入口证明的是“已核验准备回执可自动接续”。它不提供通用环境自动修复，也不证明 M02 已完成业务验收。实际恢复、集成、独立验收仍需运行证据。
