---
doc_type: REPORT
doc_status: in_progress
---

# Sandbox Manager S01 实施与验收

## 当前范围

按用户批准更新 [518 合同](518_ARCH_20261020_SandboxManagerS01Contract.md)，在独立 worktree `/data1/code/agent-platform-sandbox-s01`、分支 `feat/sandbox-manager-s01` 上实施。生产主工作区未改业务代码，没有恢复生产 Ticket。

S01-A 已提交 `c1a8399`；S01-B 实现与隔离验证完成，真实飞书验收仍待新的原生确认卡批准。此处不把协议夹具测试记作真实模型验收。

## 两步改动

A 把原 Bubblewrap 混合函数提取为共享 `sandbox-manager/environment.ts` 和唯一 `sandbox-manager/bubblewrap.ts` renderer；旧 `harness/bubblewrap.ts` 成为兼容门面。固定基线 20 组 argv、错误消息/类型与候选一致，真实 namespace/venv/完整技能及原回归通过。[A 证据](../evidence/sandbox-manager-s01/a/README.md)。

B 新增 `sandbox-manager/index.ts`、`lifecycle.ts`、`identity.ts`，只管理本次本机 Bubblewrap 进程。`withSandbox` 在协议 use 完成后仍核对根进程 close；超时 unknown 保留控制和现场，后续 SIGKILL 可以再次请求。原始异常、清理异常和迟到清理结果分别可读取。无持久 Manager 状态、资源池或后端注册中心。

`process-registry.ts` 仅保存相同 Manager control；旧 close 比较登记实例，participant clear 比较 TaskRun，存活的 managed control 不会被提前删除。Manager 拒绝信号时不残留已接受的 stop 请求。

`runner-harness.ts` 只给 platform_local + Codex + graphExecution + 受限工作区绑定 Manager。`harness/types.ts` 只增加一个可选执行端口；Codex Adapter 统一构造最终权限上下文；`codex-agent.ts`、`codex-app-server.ts` 通过同一端口执行/续接 JSON 与 app-server。协议 IO 仍在原模块，Registry 和 service abort 不持有 raw child。其他 Harness、Review、remote 和普通聊天的入口不迁移。

`runner-participant.ts` 在原 TaskRunEvent 记录不含凭据的 Backend 身份及失败 cleanup 回执。没有用进程身份覆盖 GraphWriter 身份。Writer Ownership、恢复 CAS、预算、权限策略及业务状态规则保持原权威机制。

## 验证结论与限制

[B 红绿与原日志](../evidence/sandbox-manager-s01/b/README.md) 覆盖用户指定故障，以及完整隔离 Ticket 的首次实施、文字补料、原 Session 续接和节点通过。Manager 生命周期测试、四次原生协议 execute/resume、旧 app-server、重启/Issue 执行、资源固定、完整技能包及类型检查通过。

一批旧 service-execution 回归曾收到 unknown 而断言期望 alive，失败已保留。相同测试单独在固定 A 与候选 B 均通过；原测试未记录 unknown 原因，尚不能归因到具体进程。没有放宽 Writer 或原断言，也没有扩充轮询或恢复预算。unknown 仍阻止接管。

本期不支持 gVisor。Bubblewrap root close 不是整个 GraphWriter 退出证明；依赖内容也不新增原子冻结保证。后台 Broker、阶段服务、输出和 task HOME 仍由原所有者清理。

## 真实验收

后续仅为全新的专用测试仓与路线提议原生飞书确认卡。用户批准后验证真实 Codex 首次实施、补料、原 Session、独立验收和后继放行，并补记 Manager 身份与原 Writer 证据。未批准前不得派发，不重用或恢复现有生产 Ticket。
