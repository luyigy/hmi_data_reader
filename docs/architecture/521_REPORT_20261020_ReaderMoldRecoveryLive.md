---
doc_type: REPORT
doc_status: running_business_verification
---

# Reader/Mold 真实恢复验证

## 当前结论

2026-10-20 用户批准测试原路线恢复后，M05、R6_BOLE、R6_DEMAG 已恢复并行实施。三张票均续接原生 Codex Session，在原 Worktree 中运行，经 Sandbox Manager 启动真实 Bubblewrap 进程。原飞书 Topic 的新进度卡已从飞书回读确认。

这里证明了运行环境和原实施会话恢复，不表示业务已交付。当前独立验收和后继放行仍待实际结果。

原 Run 为 `cmvdmf87w043f9xhgf9yvua6p`。沿用已确认依赖图，没有新建路线、改 Prompt、改变业务范围或替实施者编写业务代码。YIZUMI 保持暂停。

## 实际资源改动

两仓宿主项目能力配置仅增加一个只读目录：

`/home/hello/.local/share/pstack-claude/plugins/pstack/skills/poteto-mode`

包摘要仍为 `c0c9282e8d96eb9f7ef1787778c761824418577d9582dceb0e7558cd0cf16c81`。没有授权整个 HOME、整个 pstack 或递归跟随任意链接；没有挂载 OCR 模型、安装依赖、启动第二套 OCR 或改动 browser/Python/runtime 声明。差异见 [policy-diff.json](../evidence/reader-mold-recovery-live/policy-diff.json)。

项目配置更新会改变 policy hash，因此通过既有 `migrateLegacyProjectScope` 对本路线两仓全部 14 个未完成执行追加匹配新 hash 的 scope 回执，避免留下当前项目配置与旧 scope 不匹配的未完成执行。它们的 runtime 声明兼容性和 Writer 退出均由原接口复核，未覆盖旧批准事件或 runtime pin。此步骤只登记能力，不恢复任务、不刷新预算。仅三张选定票随后收到恢复准备回执。见 [scope-applied.json](../evidence/reader-mold-recovery-live/scope-applied.json)。

已完成票未迁移或重新运行。源码没有修改；没有重启平台或 OCR 服务。

## Manager 中的预检

使用已实现的 `withSandbox`，没有增加另一套沙箱启动器。按已授权精确目录，在三张票真实 Worktree 的只读沙箱中分别执行：

- 完整读取技能包 70 个普通文件，拒绝意外 symlink。
- 核对 SKILL、Codex 工具映射、checker 和项目 playbook，运行原 checker，三次均 exit 0。
- 使用原已允许的网络策略请求现有 `127.0.0.1:8767/health` 和 `/ready`，三次均成功。
- 检查进程等待根进程 close 后由 Manager 收尾；这不是业务 GraphWriter 退出证明。

结果与 Bubblewrap backend 身份见 [manager-preflight.json](../evidence/reader-mold-recovery-live/manager-preflight.json)。仅 health/ready 不证明识读内容、版本和业务合同兼容，这些仍需真实实施验收。

其他相邻 pstack 技能目录没有因此自动放开。当前 Agent 已读取本包的实施/恢复 playbooks 并继续工作；若发现额外必需资源，应按实际依赖核实，不能把任意辅助技能链接自动变成宿主授权。

## 原入口恢复与运行证据

使用 `registerPlatformPreparation` 登记三份 `missing_capability` 准备证明，绑定原 revision、claim、候选和依赖及不可变证据文件 SHA。既有 Coordinator 消费回执，调用原 `scheduleImplementationRecovery`，执行原 Writer 退出检查和 CAS，然后领取新 claim。没有直接更新 ready/claimed。

准备登记回执见 [registered.json](../evidence/reader-mold-recovery-live/registered.json)。首次运行取证见 [execution-evidence.json](../evidence/reader-mold-recovery-live/execution-evidence.json)。

| Ticket | 新 TaskRun | 复用原生 Session | Manager root PID |
| --- | --- | --- | --- |
| M05 | cmvgs27st2w3avo4gtrr0n84a | 01a1587f-7e05-7df0-a533-d3fb2a02beb6 | 2516597 |
| R6_BOLE | cmvgs236f2vytvo4gchm449g6 | 01a1587f-60a4-78b3-93ba-de4f05d21a97 | 2514833 |
| R6_DEMAG | cmvgs23jd2vzdvo4ge2nb4dbn | 01a1587f-89e7-78e3-a840-f066bd4bd444 | 2515278 |

运行身份还包含 backend、bootId 和 startTime，不用 PID 单独判定所有权。三个实际运行目录均等于原专属 Worktree。运行元数据上的 Session 与旧实施 participant 相同，不只是启动参数里请求了 resume。

原 snapshot 内容/hash 不变；候选分别仍从 `f4d0b48d...` 和 `f12e3ac3...` 接续。首次取证时 revision 由 6 正常推进到 10，四类已用预算仍均为 0，没有被重置。Writer 观察为 alive，说明当前正由原权威机制保护；不能此时重复恢复。

三张新卡均取得飞书 GET 成功回执，chat/root/thread 与原任务绑定相符，见 [topic-check.json](../evidence/reader-mold-recovery-live/topic-check.json)。本轮没有伪造用户补料消息，正常人机交互仍需真实用户在原 Topic 输入。

## 业务验收待核对

- M05：真实消费 R05 固定包，Reader 调用、权限/API、1440/390 视口保存重开。
- R6_BOLE：最多一个控制器和一个新增物理版式，开发/保留样本和固定包，不混用其他控制器图片。
- R6_DEMAG：同样核对控制器身份、真实图、识读与固定包。
- 独立验收通过后，观察原图对 M6_BOLE/M6_DEMAG 的放行；不能提前标 passed 或手工放开后继。

业务结果后续按实际测试、页面/API、产物 SHA、完成和阻塞原因追加。本文件当前状态为实施进行中。


## 22:33 CST 业务进展取证

三票均仍在实施。M05 已修改固定包接纳、投影和保存链路并调用本票 pytest 入口；这里不把命令调用记成测试通过。R6_BOLE 已开始补 B&R 射出页面原始识读，R6_DEMAG 已开始调整页面包生命周期支持。两仓 Agent 各自在原 Worktree 写代码，没有由本父任务代写。

[当前状态与代码文件清单](../evidence/reader-mold-recovery-live/latest-status.json) 记录取证时点；[不变量检查](../evidence/reader-mold-recovery-live/invariants.json) 确认原快照和所有旧 runtime pin 不变，执行记录仅三张选定票发生状态推进，其余四个 Attention 原执行记录未变。该取证后业务 Agent 会继续运行，不能把文档采样状态当实时终态。

本轮恢复测试已证明 Manager 管理的真实 Codex 能续接原 Session 并重新进入业务实施。业务交付、自然补料闭环和独立验收仍未完成，不宣告全部路线恢复成功。
