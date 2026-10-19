# 检查和接续暂停的任务

在平台服务目录运行本地运维命令。默认只读，输出依赖、候选提交、原工作区、当前 TaskRun、实际写入者观察和处理动作。

```sh
npm run task-graph:doctor -- --run-id cmvdmf87w043f9xhgf9yvua6p --node-key M02
```

修复卡点、准备运行环境后，显式登记实施接续：

```sh
npm run task-graph:doctor -- --run-id cmvdmf87w043f9xhgf9yvua6p --node-key M02 --resume --request-id m02-platform-recovery-20261019-01
```

命令供有平台数据库访问权限的本机运维者使用，不能暴露成无认证的远程接口。它调用既有 `scheduleImplementationRecovery`，保留候选、原始基线、预算和退出检查。不重置预算，不删除目录，不重启服务，不伪造验收。

回执 `scheduled` 表示本次新受理，附账本事件 ID。`already_scheduled` 表示同一请求以前已受理，本次没有重新派发。如果后续再次暂停，应先处理新的卡点，再使用新请求标识。网络或客户端超时后的重试沿用原标识，避免重复执行。

`ready` 只表示排队。确认执行启动需要继续读取新的 TaskRun、实际原生进程及工具事件。没有退出证明或工作区归属异常时，恢复仍明确失败，不把任务强改为运行中。

## 2026-10-19 M02 诊断

旧写入者已经释放，但全进程扫描遇到同用户 SSH 进程的 `environ` 权限错误，于是返回 `unknown`。实际父链为 `2557519 → 2557418 → 3384943 → PID1`；独立 SSH 服务祖先出生早于图协调器，且不在协调器的祖先链中。

修复只在 `EACCES` 时尝试独立父链证明。核对当前 supervisor 的 PID 和出生时间，读取其全部祖先，再寻找候选进程的独立、早生、非 PID1 锚。两遍读取的 PID、出生时间及父 PID 都相同才排除候选。共同祖先、PID1 孤儿、父链缺失、身份变化和真实任务子进程继续阻止接管。

这个证明沿用运行器既有约定：nonce 只注入新启动的 harness，不注入预存在的服务器。它不防御恶意代码通过 IPC 向其他服务传递 nonce。

新 writer 创建时保存完整祖先身份。owner 仍活时，当前链必须与保存链一致；owner 已退出时，仅允许使用经验证保存的链替代已经消失的 owner 链，仍重扫全部 nonce 候选。历史共同祖先继续拒绝，存活历史祖先身份变化也拒绝。没有保存链的旧 writer 在 owner 消失后仍可能返回未知。

本次首次空闲加载后，M02 又触发了旧 owner 已消失的边界，恢复被拒绝，没有产生新派发。M02、R05 的旧身份迁移使用本轮独立复核在加载前实际读取的完整链，来源为 `/root/recovery_boundary_review` 的工具输出 `chunk38cb7f`，事后归档并明确标注。迁移核对原 supervisor 确实不存在、boot/host/uid、两个 writer nonce、匹配 release、当前 claim/revision/candidate 及存活祖先身份，追加 `operator_writer_ancestry_migrated` 事件。它只补身份数据，不改变状态、预算或候选，也不把先前 `exited` 布尔值当作免扫描许可。

回归入口：

```sh
npm run test:task-graph-postgres -- task-graph-process-lineage task-graph-writer-ownership task-graph-lifecycle-adapters task-graph-restart-recovery task-graph-implementation-recovery task-graph-failure-summary
```

使用独立 PostgreSQL schema。真实 nonce 子、不可读真实子、共同祖先、孤儿、断链、PID 重用及再次暂停后重复旧请求均有反例检查。独立复核由 `/root/recovery_boundary_review` 完成，精确模型未记录。

M02 的现有浏览器已复制进该 job 的 ignored `scratch/platform-browser-*`，沙箱预检实际读取 `m02-runtime-ready` 页面。该预检证明当前目录内浏览器可用，不代表 M02 的真实识读或双视口业务验收通过。Reader 固定交付的控制器与样本证据仍由实施者核对；确有缺项时要指出具体字段、来源和补救措施。
