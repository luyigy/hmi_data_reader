<!-- ap-publish:ticket-independent-delivery-20261023:SPEC -->
<!-- ap-ticket-v1 {"version":1,"project":"ticket-independent-delivery-20261023","sliceKey":"SPEC","parent":null,"blockedBy":[]} -->

# S02：Ticket 独立交付优先

## 问题与结果

独立目标被装进同一个多 Execution Node 时，会一起等待组合齐备。修正拆票约定和 Agent 提示，让每个可独立验收的目标成为一张 Ticket/Node；Execution 是票内执行。综合验收单独成票并显式依赖前置。真正不可拆分的联合目标继续使用多 Execution、完整版本绑定和全部集成条件。

本包只含两张实施/验收票：S02_A「独立交付规则落地」→ S02_B「真实 Agent 与旧任务兼容验收」。这是依赖方向说明，正式关系只从 Gitee Issue 受控元数据读取；manifest 不重复编写依赖。

## 已定范围

- A 同票交付项目拆票规范、提审示例、实施提示和必要回归，不按文档/代码/测试拆水平票。
- 每票正文明确独立目标、验证方法、输入、完成标准和真实前置；默认一个 Node 一个 Execution。仅方便并行开发不构成联合理由。
- 多 Execution 例外正文必须说明不可拆分原因、共同完成标准、版本组合及原合同中已批准的质量责任方。
- 单执行实施期间完成自查，首次合法 delivered 携带正式结论；平台集成后消费有效回执。若合并改变代码或证据/版本变化，沿现有原 Session 补验；不承诺所有情形只启动一次。
- 保留 Tester、人审、失败回修、格式纠错、固定版本、安全隔离及真实依赖。独立完成不保证物理并发；资源排队不在本轮范围。

## 两张票及责任

A 无前置实施票；B 明确依赖 A 正式 passed，固定 A 的集成 SHA 才验收。两票均单 Execution，建议 local:codex 实施、local:kimi-code 独立 Tester，采用现有 lean + agent 配置。Tester 未参与编写，独立核对范围和验收；自查不能冒充独立审查。本轮不增加平台角色或额外架构门禁。人可在路线卡调整现有分工。

## 验收设计

| ID | 行为/反例 | 证据与责任 |
| --- | --- | --- |
| A1 | 独立目标分票，综合目标显式依赖；联合例外说明完整 | A 更新规范与示例，Tester 对照 Issue 导入结果，不新增运行期语义判官 |
| A2 | 单 Execution 不再被提示等待“其他执行”；合法首次自查无需强制第二轮 | A 的提示与真实协调器隔离回归；无变化版本断言一次实施，证据变化走原补验 |
| A3 | 测试 IA、IB 独立；ID 仅依赖 IA；IC 依赖 IA+IB。IB 保持活动或真实阻塞时 IA passed、ID ready/完成、IC planned | 使用真实 Git、隔离 PostgreSQL 和现有协调器；不可直接写 passed 充当完成。另覆盖 IB passed 后 IC 释放一次，IC 失败不放行其后继、不撤销 IA/IB |
| A4 | 联合票缺任一集成/兄弟版本不得通过；组合变化拒绝旧结论；空 executions 不通过 | 对现有 implementation-quality/store 合同做回归，保留完整绑定和全部集成条件 |
| A5 | Tester、人审、失败回修后换版、格式反馈原 Session、Git 冲突/CAS、legacy implement 的 delivered_unverified 语义 | 复用已有 suite；每项报告真实命令/结果。已有正确行为作基线，不制造假红测 |
| B1 | 真实 Coding Agent 运行 IA/IB/IC/ID，同样满足 A3 时序；原 Session 自查/必要补验有 TaskRun 与固定 SHA | 另提审的最小测试路线批准后运行；原生 Agent 会话、账本事件及结果文件，不能用 mock Harness 代替 |
| B2 | 新合同中实际 Tester 与人审按获批配置工作；失败/换版不能使用旧通过结论 | 以测试路线批准的模式执行，不能让两票外层 Tester 代替内层被测行为；人审由真实批准人操作 |
| B3 | 旧 Reader/Mold 批准快照、Tester、人审/检查条件不变；未通过业务票合法续接及正式结果如实记录 | 先只读核对旧账本；已有 passed 不重跑。剩余票恢复仅按原批准范围和现有授权流程；条件未满足则 B 此项未完成 |
| B4 | A 固定版本、真实运行版本、输入、事件、原生会话、独立报告相互对应；旧票与新合同结果分开 | 复用现有 snapshot、TaskRun、execution.evidence、commit、Node evidence/events；报告附实际来源，不新增追溯实体 |

## B 的最小真实测试路线设计

IA：Reader 针对固定批准样本验证输出字段、单位、unknown/partial；一个 Node/Execution。
IB：Mold 使用固定 JSON 契约样本验证导入、展示、保存重开；一个 Node/Execution。它不依赖 IA 的新接口，才能独立。若实际需要新接口，必须显式依赖并另选合法独立样例，不伪造并行。
ID：只依赖 IA，消费其固定交付执行输出契约核对。
IC：依赖 IA+IB，真实图→Reader→Mold→1440/390 双视口保存重开；一个执行负责集成测试，沿现有 consumeUpstream/services 取得固定输入。

IB 的未完成窗口使用批准的 waiting_for_user 测试步骤，由原生 Agent 正常请求输入并由用户实际回复；不手改生产状态、不挂死进程、不中断 TaskRun。观测必须证明 IA 完成时 IB 尚未完成；仅看最终全绿不能证明独立性。资源不足时可以验证 IB 阻塞、IA 继续，不扩大为调度器改造。

具体样本文件/哈希、真值、两仓固定提交、端口/隔离环境、检查命令及测试节点模式在 B 提交的测试路线卡中冻结。此包批准仅授权 B 准备和提审该测试路线，不授权跳过那张卡的确认。B 不得先把运行结果标通过再补批准。测试路线只服务本次验收，不增加本次产品改造范围。

## 兼容性与现场基线

2026-10-23 20:45 北京时间，只读正式账本：Reader R6 六张 passed；Mold M6 四张 passed；M6_ARBURG attention（浏览器导航阻塞），M6_YIZUMI attention（缺独立图/真值），M07 planned 等两者。当前无活动 Graph TaskRun。生产 run 为 cmvdmf87w043f9xhgf9yvua6p，snapshotHash 为 9f4925fed7ddb9bde0f083d0659529fe3a71d539b2d1a99944eb753d0661e503，仍为 legacy + 独立 Tester。

Reader 日精 48d13d248aecb676a8da23664e775d6ed2dcbe0f、Mold 日精 be8d23da794b531a85eef2fe6d9d00398e1bcd46 已正式通过声明的部分识读/草稿保存重开范围；不是完整识读或生产 Run。B 开工重新核对，不把上述快照当成届时仍成立的事实。

旧票兼容有两层：只读证明合同未变，以及条件具备时的真实合法续接。第一层不能冒充第二层。若旧票仍缺材料/环境，保留新合同已取得证据，B 保持未完成并报告具体阻塞，不降低完成标准。

## 施工约束与不做项

按 pstack 限定范围、最小修改、逐段验证、实施与独立审查分开。发现实际缺陷先复现再修；原本正确行为做回归。额外风险只记事实、影响和建议，不擅自加机制。先运行长文件守卫，达到阻断阈值的文件不得增长。

不新增状态机、角色、恢复管理器、质量门禁、追溯实体或合同版本；不删除全本票版本绑定/全部集成条件；不改 schema、调度并发、旧票批准快照；不重写历史、不中断生产 TaskRun、不自动重跑 passed 票、不自行部署或重启生产服务。实施与真实测试使用现有隔离机制；B 的生产部署/恢复如涉及额外操作，先按既有授权范围办理。

## 可审查交付

每票报告固定 SHA、改动文件、逐项实际命令/结果、证据位置和未完成项；对应回归随最小修改交付。A 可以跨 Session，B 不承诺单 Session 完成。测试通过不等于独立审查通过，准备路线卡不等于批准实施。

参考：用户的 541 文档原样快照见 architecture-reference.md；上轮拟议 Diff 与本轮票据设计见 route-review.html。历史 ADR 的“未部署”描述是当时状态，本次以 5367a4bed54cf20ce9b4e698f98fc269d7634286 的源码为基线，不重新扩大架构讨论。
