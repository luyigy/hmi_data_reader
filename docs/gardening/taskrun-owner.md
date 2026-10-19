# 防线 taskrun-owner：飞书清理保留任务图归属

状态：Active。本轮红绿重演及独立复核通过，复核范围为此处明确列出的归属错误。

## 根因与事故证据

平台级错误。飞书服务启动清理以 TaskRun 显示状态推断工作已退出，修改了任务图协调器负责的运行记录。原生 Agent 仍在运行，却向用户显示会话结束。

[历史回执](../evidence/workflow-reliability/startup-cleanup-verification.json) 记录同一次事故影响 M01、R02、R04 三项 TaskRun。三项 `priorCompletedAt` 均为 `2026-10-18T14:06:06.565Z`。对账后运行状态恢复，随后读取记录的三个原生 PID 均仍存活。三项受影响执行不等于三次独立复发，现有证据不能计算跨事故复发率。

归属边界由 [b4dee81](https://gitee.com/luyi1678/agent-platform-v2/commit/b4dee813d37f27b8e20ce900b283a29c6e601275) 中的 `cleanupFeishuOwnedStaleTaskRuns` 实现。TaskRun 有图写入者、复核者、旧图执行绑定或图复核任务身份时，飞书清理保留它，交给图协调器处理。已知存活的普通原生会话也保留。

## 防线与验证

防线由明确的清理归属检查及 [行为回归](../../tests/feishu-startup-task-cleanup.test.ts) 组成，测试已经登记到隔离 PostgreSQL 回归入口。本轮复用它，不再添加一条仅靠 Prompt 遵守的规则。

```sh
node scripts/verify-taskrun-ownership-wire.mjs
```

2026-10-19 的 [回执](../evidence/gardening/taskrun-owner/receipt.json) 标明实际检查的源码和测试摘要：

- [红色日志](../evidence/gardening/taskrun-owner/red.log)：只在一次性副本中移除 `graphOwnsRun` 守卫，图任务实际状态变成 `completed`，预期为 `running`；检查退出码 1。
- [绿色日志](../evidence/gardening/taskrun-owner/green.log)：恢复同一份正确源码，守卫覆盖图写入者、旧绑定、复核者、存活原生会话和 pending；检查退出码 0。重复清理仍通过。

脚本没有修改原仓、实际 TaskRun 或运行服务。每次执行使用新建 `task_graph_test_*` schema，正常结束后删除自己创建的 schema 与临时副本。脚本等待既有测试入口完整退出，不附加只终止外层进程的超时。异常信号或无法确认正常退出时保留临时副本，数据库与后代进程须另行核对，不宣称已回收。

## 复核及边界

本轮独立 Verifier 为 Codex 代理 `/root/matt_pstack_review`，未参与实现，精确模型版本未记录。它核对红绿日志及源码摘要，并要求移除外层超时导致的清理风险后才通过。[复核回执](../evidence/gardening/taskrun-owner/review.json) 保留审查范围与限制。既有修复回执中的 `gpt-6-sol @high` 是历史复核，不冒充本轮代码复核。

本测试证明当前守卫能拦截注入的具体历史错误，不证明所有归属错误均已消除。新的写入口仍需明确归属并接受相应检查。本报告不改变任何业务节点的交付或验收状态。真实运行中后续拦截次数未测量。
