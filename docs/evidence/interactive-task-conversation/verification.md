# 任务话题接回原执行者的验证

## 已实际验证

`npm run test:task-graph-postgres -- task-graph-conversation-delivery task-graph-interactive-conversation task-graph-continuation task-graph-conversation task-graph-implementation-recovery` 已通过。

补充运行 `task-graph-interactive-conversation task-graph-conversation-materials task-graph-conversation-delivery` 已通过。

全部数据库写入使用脚本创建的 `task_graph_test_*` 隔离 schema。Git 使用临时双仓；执行器使用受控 harness，飞书出站使用明确替身，没有操作业务 Run。

- Reader 和 Mold 同时启动。Reader 正常提问等待时，Mold 独立完成检查与验收。
- 普通回答不包含“继续”命令，仍接回相同 execution、工作区和原 native session；没有失败预算扣减。
- 实施结果返回前追加纠正，封口先将消息交给下一轮实施；不会直接合流旧结论。
- 只有原检查和验收成功才启动后继。仅实施后继仍明确标记未独立验收。
- 完成后的连续两次问答使用原实施会话及上次返回的新 native session ID；固定 commit/evidence 不变。
- 历史材料等待经原实施者判断后，仅恢复目标 execution；同节点 permission_required 兄弟不被恢复。
- 原生 steering unknown 不重发，rejected 留待普通下一轮；保留开始与结果审计。
- 用真实独立子进程创建 writer，进程存活时不能接管，实际退出后才生成投递不确定的恢复上下文；并发收口幂等。该证据覆盖写入者退出和重启后的账本收口，不声称运行了线上服务重启。
- 图片原始引用通过 inbox 去重保留，宿主绑定话题下载、来源索引与真实只读 Bubblewrap 读图验证继续通过，未暴露飞书凭据。

## 上线前限制

本次没有重启或热加载线上服务。新进度状态需要所有 reader 同时兼容，不能把本实现拆成旧 reader 与新协调器混跑。

测试证明平台调度与会话传递契约，未证明真实模型对每一句自然语言都理解正确。模型输出只有 delivered 才进入检查与独立验收；普通回答、问题和补充都不构成验收证据。

## 最终定向回归

以下七组组合运行退出码为0：

```sh
npm run test:task-graph-postgres -- task-graph-conversation-delivery task-graph-interactive-conversation task-graph-conversation-materials task-graph-restart-recovery task-graph-continuation task-graph-implementation-recovery task-graph-conversation
```

补齐审查指出的失败循环、消息权限和阶段旁路后，以下三组退出码为0：

```sh
npm run test:task-graph-postgres -- task-graph-interactive-conversation task-graph-conversation-delivery task-graph-service-execution
```

本轮额外断言包括混合管理员/非管理员消息不借权、准备失败退避、原生失败沿rootInputId不重置额度、运行释放与终态写入的竞争、未绑定graphReview不得另开复核、正式架构/验收仍正常执行。

`npx tsc --noEmit --incremental false`、`npm run check:long-files` 与 `git diff --check` 均通过。
