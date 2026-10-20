---
doc_type: ARCH
doc_status: completed
next_action: none
---

# S02 最小边界合同 v1

日期：2026-10-20。基线：`d532c5e`。前置调查见 [S01](507_REPORT_20261020_MattPstackS01.md)，本轮复现见 [验证记录](../evidence/matt-pstack-s01-reliability/verification.md)。

本文件定稿设计和验收要求，不代表代码已修复，也不批准生产恢复。实际实施仍须按仓库规则提交 Spec、Issues 和路线确认卡。

## 用户应当看到什么

用户在原任务话题回答问题后，原执行会话继续。正常等待不扣失败预算。验收恢复不会被上一轮清理过程吞掉。已完成的独立分支不重做，后继只在批准的完成条件满足后启动。

首片交付应演示这些行为，不以移动文件或增加接口数量作为完成条件。

## 范围

S02 只收敛会话封口、正常等待再排队，以及本轮暴露的领取和复核交接问题。保留现有 inbox、原生 session、阶段 worker、执行账本和协调器。修复可靠性与转移操作归属放在同一片验收，不另建一组横向准备票。

Issue 来源与暂停决策分离、runner/followup 导入环拆解、Inspector 和 Gardening 自动化留在后续。不得顺带增加第二套调度器、放宽授权、重置预算或删除旧恢复适配器。

## 状态写入允许清单

| 职责 | 允许写入 | 不允许拥有的决定 |
| --- | --- | --- |
| 会话入口与投递 | inbox、输入绑定、steering 回执、会话结果、投递游标 | phase/state、claim、预算、节点完成 |
| 执行账本内部的会话转移模块 | 封口、等待输入再排队、后续问答 reservation，及其 revision/事件 | 绕过输入归属、writer 退出或批准范围 |
| 原有实施结果与复核发布入口 | 在各自合同内处理结果、回修、复核通过和有限重试 | 用普通聊天替代验收、跨 claim 发布 |
| 协调器及恢复入口 | 安排账本允许的下一阶段、管理进程内 in-flight 工作 | 把复用旧 Promise 当作已启动新恢复 |
| 展示与 tracker | 发送回执、Outbox、状态投影 | 反向授予执行或验收权 |

不创建一个可任意改字段的通用 setter。会话消费者调用有业务含义的操作；节点、执行和事件在同一事务内提交。

### 会话转移接口

模块先保留在 `task-graph` 目录。对外只提供封口和等待再排队两项操作，方法名可沿用 `sealConversationTurn`、`reconcileConversationWaits`。输入解析和网络投递不进入此模块。

封口输入绑定 execution、当前 claim、expectedRevision 和 candidate。事务取得节点锁，重读执行身份并核对输入回执。封口前的纠正进入下一实施 turn；未知 steering 结果保留现场；没有待处理输入才转入集成。

等待再排队只能接收 `waiting_for_user`，不能将 `waiting_decision`、`exhausted` 或未知 writer 解释为可执行。writer 退出证据、输入归属和当前执行版本一致时，原子更新执行、节点和 Run。保留候选、原生会话沿袭、全部失败预算及来源消息。

原调用方迁移后删除对应直接状态写入，不保留两套封口或再排队逻辑。

## 慢观察与短事务

本轮 P2028 的直接原因是后续问答领取事务中执行了进程扫描。5 秒是当前事务限制，不是 writer 失效时间。

调整为读取身份、事务外观察、锁内复核并提交。观察结果绑定全部相关 execution 的 claim、revision、候选、worker nonce/release 标记、TaskRun 身份。涉及旧问答时也核对 reservation、绑定的 TaskRun 及其控制元数据。

锁内发现身份变化时返回“需重新观察”，不得应用旧退出证明。新 reservation 竞争必须由同一节点锁及幂等键裁决；实际启动前仍须执行原有绑定门禁。`alive` 和 `unknown` 均不授权接管。

不在持有节点锁时扫描 `/proc`、执行 Git、访问网络或启动模型。不用缓存的宽泛“此节点已退出”布尔值代替身份绑定，也不靠增大事务超时通过验收。实施时应逐个迁移本片路径，不宣称全仓所有慢事务已清除。

## 复核恢复必须能跨进程重建

当前恢复先删除旧 review 绑定，再调用按节点去重的 `verifyNode`。旧 Promise 尚未清理时，该调用直接返回旧工作，新的 recovery 标识丢失。周期重试随后撞上同候选旧 claim，形成空转。

恢复授权、唯一 requestId、新 review generation/claim 和固定候选必须在一个受控事务中持久化。实际阶段为 architecture 或 acceptance 时沿用相应角色合同，不用一个 acceptance 总开关覆盖阶段语义。

旧 in-flight 工作只负责结束和释放自己的 nonce。新恢复由协调器在 writer 退出且当前 claim/revision 匹配后领取。进程内 Map 只能去重同一代工作；不能替代持久恢复请求。

不能只加一次 `await oldPromise` 就宣布修复。必须覆盖“恢复已提交、新复核尚未启动时进程退出”的恢复路径。新 claim 不复用已消费的候选 claim，也不靠删除旧事件解除冲突。并发重复恢复幂等；不同请求竞争只接受仍匹配当前版本的请求。

旧 Run 的恢复事件由现有兼容适配器解释。无法无歧义识别的旧记录输出证据，不猜测新身份。完成、预算耗尽、writer 未知或候选变化的节点不能由本合同重新排队。

## 首条 Boundary Wire

规则用 TypeScript AST 检查直接 Prisma 写入及 `metadataWithProgress` 的调用，不用文本关键词计数。规则清单明确文件、导出函数、模型和允许字段；不接受整个 `task-graph/**` 的无限豁免。

本片门禁只覆盖迁移后的会话消费者及两项转移操作。已存在的其它 writer 记为带源码定位的清单，不称其安全性已获完整证明。动态调用、原始 SQL 和别名逃逸不能靠该规则穷举，仍需行为测试和代码审阅。

反例必须真实插入消费者直接写 phase/status 的代码并使门禁失败；合法操作通过。规则本身不得修改源码或数据库。

## 必须通过的验收

| 场景 | 必须观察到的结果 |
| --- | --- |
| 进程观察超过当前事务上限 | 观察发生在事务外，领取成功；claim/revision/候选发生变化则拒绝旧证明 |
| writer alive/unknown、两个领取者竞争 | 不重复启动；无有效退出证明不得接管 |
| 正常回答、重复输入、封口前纠正 | 原 execution/session 继续，纠正先于集成，预算不变 |
| 旧复核发布暂停、尚未释放时接收恢复 | 请求持久化且不丢失；旧 writer 退出后启动新一代复核 |
| 上一场景提交恢复后重启测试进程 | 由新进程接续已登记请求，无需再发一次继续 |
| B 复核失败后有限回修 | A 不重跑，B 保留候选并完成复核，C 自动启动 |
| 过期 claim/revision、旧复核结果、撤销授权 | 拒绝发布或派发，预算与交付事实保留 |
| 非法会话直接写状态 | Boundary Wire 红；合法接口绿 |

复用 `task-graph-interactive-conversation`、`task-graph-conversation-delivery`、`task-graph-execution-progress`、`task-graph-issue-execution`，补充受控延迟、释放竞态和跨进程反例。所有数据库测试仍用临时 schema runner。禁止用 mock 掉 writer/claim/revision 检查的测试证明安全。

验收记录必须区分“成功复现故障”和“修复后通过”。本轮完成前者。S02 实施完成后才能记录后者。
