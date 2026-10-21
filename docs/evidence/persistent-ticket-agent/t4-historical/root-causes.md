# T4 历史 Ticket 接续的两处公共缺陷

用户于原飞书消息 om_x100b62b9b8ae94a0cf2b420b2814528 明确授权恢复 Reader/Mold，以真实业务验证修复。目标路线 cmvdmf87w043f9xhgf9yvua6p；没有重建路线或清空计数。

## A. 项目 Runtime Pin 被误当平台代码版本

preparation-recovery.ts 原先要求已耗尽平台验收的旧 Runtime Pin 必须 source.origin=host_registration，并比较 source.commit 与修复代码提交。项目授权合法允许 source=null；即使 source 有提交，它也可能指项目资源版本，不应作为平台程序版本权威。BOLE 正好是项目 Pin、无资源声明，因此旧门禁永久拒绝当前已经核验的修复。

修复仅保留原执行/claim 绑定的 Pin 身份核对，平台修复版本仍核对显式 remediationCommit 与宿主实际 HEAD。原候选、revision、依赖、旧实施/验收 Writer 退出、校验产物 SHA256、同候选同修复最多一次均未删；新验收仍通过原 Runtime/Project Capabilities 预检，不从运维回执获取额外资源权限。

红：真实 Coordinator 隔离用例保留 source=null 的原 Pin，旧代码报 Recovery requires a different verified platform code measure。绿：同一用例通过，仍验证错误 binding、错误 execution Pin、产物篡改、重复修复凭据拒绝；验收再次失败仍 exhausted，platformAttempts 保留 2，不补预算；通过后才释放后继。另一路 host_registration 的历史格式继续通过。

命令：node scripts/test-task-graph-postgres.mjs task-graph-prepared-review。

## B. 冲突诊断文本覆盖了可解析证据

conflict-repair-recovery.ts 将 JSON 冲突证据与恢复错误不断拼接到 failure.detail，下一轮 JSON.parse 对混合文本失败，又追加一次错误。FANUC 的 revision 已达 282，仍未进入冲突实施。

修复优先读取合法结构；混合诊断不可解析时，读取同 node、同 claim 的原始 execution_outcome 冲突证据，严格核对候选。随后仍使用原 prepareConflictRepair 核对 Git 实际合并父、批准提交、文件集合与所有权。错误诊断规范化；同一失败不重复追加或推进 revision。没有从任意文本截取 JSON，也没有把缺失证据当作可以合并。

红：在原冲突续接夹具中保留原账本证据、向当前 detail 加诊断后，旧代码无法进入 claimed 修复阶段。绿：同夹具完成只读源码/批准输出目录、SIGKILL 后恢复、原 Session 当前 Stage、受控合并、检查、独立验收及后继一次释放。

命令：node scripts/test-task-graph-postgres.mjs task-graph-conflict-continuation task-graph-conflict-repair。

## 仍保留的边界

没有按 BOLE/FANUC 名称写条件，没有修改批准快照、原 Runtime Pin、挂载、候选、成本限制或模型 Prompt。宿主经现有登记和恢复入口操作，不写数据库把节点强改 ready/passed。当前线上其他 Coding Agent 已启动时，不强行重启 Coordinator 杀死它们；公共入口可以由加载新代码的受信任宿主进程调用，服务在真实空闲时更新。
