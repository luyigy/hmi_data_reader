---
doc_type: REPORT
doc_status: audited_pending_approval
---

# Reader/Mold 原路线恢复审计

## 结论

原路线可以保留，当前还不能直接恢复业务实施。七张 Attention Ticket 的保存点、Worktree 和原生 Codex Session 均在，Writer 已退出，预算没有耗尽。共同阻塞仍存在：这两仓的旧批准资源里没有 poteto-mode 的真实技能包。另有 OCR 模型可用性缺口和 YIZUMI 资料源问题。

建议先准备并审批精确资源，再由用户批准恢复 M05、R6_BOLE、R6_DEMAG。这三票原来就无相互依赖，各自写独立 Worktree。无需重做业务 Spec、依赖图或调度器。

本轮没有恢复任何生产 Ticket，没有修改批准快照、宿主权限、业务源码、运行账本、预算或服务。仅新增本报告和脱敏审计证据。图片读取只在内存核对，没有落盘或发送。

## 基线与证据

- 平台分支 `oss-prep`，HEAD `4d884fbab9375f54c62f3ca32acfb699e59e81cb`。
- Run `cmvdmf87w043f9xhgf9yvua6p`。
- 原确认提议 `cmvdlhdks00016tzec70fn7ui`，2026-10-18 已确认。
- 原快照 SHA-256 `9f4925fed7ddb9bde0f083d0659529fe3a71d539b2d1a99944eb753d0661e503`；doctor 核对确认提议、节点依赖和执行仓库/基线/角色均一致。
- 2026-10-20 12:26Z 起只读采样。数据库快照使用 `REPEATABLE READ` 和 `SET TRANSACTION READ ONLY`。进程观察与文件/远端查询分开采样，不宣称原子快照。
- [完整节点清单](../evidence/reader-mold-recovery-audit/inventory.json) 保留全部 24 个节点的依赖、执行 ID、claim、revision、候选、集成提交、Worktree、原生 Session、预算、Writer 探针及 Topic 绑定。
- [资源授权和沙箱探针](../evidence/reader-mold-recovery-audit/resources.json)、[Python/浏览器检查](../evidence/reader-mold-recovery-audit/tool-probes.json)、[OCR 缓存可见性](../evidence/reader-mold-recovery-audit/ocr-probe.json)、[资料源错误及图片读取](../evidence/reader-mold-recovery-audit/source.json)。
- 原始 doctor、数据库快照、执行脚本与 Gitee 读取结果留在忽略目录 `output/reviews/reader-mold-recovery-audit-20261020/`。不提交原始凭据、Base token 或用户消息。
- 审计前后 Run 连同全部节点/执行、TaskRun 和 TaskGraphEvent 完全相同，见清单 `unchanged`。七张前沿 Issue 当前均 open/blocked。本轮未更改标签或正文。
- 独立 Sandbox Manager 测试路线 `cmvgnje8n01y8wsd7oks8pzvq` 在审计末次采样已 completed，T01/T02 均 passed。这证明新测试路线完成，不代替旧业务路线的资源批准和业务验收。

## 全部节点与依赖

| 节点 | 当前状态 | 前置 |
| --- | --- | --- |
| R01 | passed | 无 |
| R02 | passed | R01 |
| R04 | passed | R01 |
| R05 | passed | R02、R04 |
| M01 | passed | R01 |
| M02 | passed | R02、M01 |
| M03A | passed | M02 |
| M03B | passed | M03A |
| M04C | passed | R04、M01 |
| M04T | passed | R04、M01 |
| M05 | attention | R05、M02、M04T、M04C |
| R6_ARBURG | attention | R05 |
| R6_BOLE | attention | R05 |
| R6_DEMAG | attention | R05 |
| R6_FANUC | attention | R05 |
| R6_NISSEI | attention | R05 |
| R6_YIZUMI | attention | R05 |
| M6_ARBURG | planned | R6_ARBURG、M03B、M05 |
| M6_BOLE | planned | R6_BOLE、M03B、M05 |
| M6_DEMAG | planned | R6_DEMAG、M03B、M05 |
| M6_FANUC | planned | R6_FANUC、M03B、M05 |
| M6_NISSEI | planned | R6_NISSEI、M03B、M05 |
| M6_YIZUMI | planned | R6_YIZUMI、M03B、M05 |
| M07 | planned | 全部六张 M6 |

10 个 passed 不重新实施。旧工作区/Session 文件有部分已被正常清理，所记录候选和集成提交对象仍存在，不能把清理视为成果丢失。7 个 planned 尚无实施身份，不应人为跳过前置。

## 七个暂停节点的恢复现场

全部为 `attention / implement / waiting_decision`，revision 6，最新实施 TaskRun completed。doctor 的实际 Writer 探针均为 exited，不只是检查数据库 completed 或旧 PID。其 phase worker 释放记录、GraphWriter nonce、boot/startTime 与 TaskRun 释放记录保留在清单中。恢复时仍须重新采样，不能永久复用本报告的退出证明。

| 节点 | 执行 ID | 候选前缀 | 原生 Codex Session |
| --- | --- | --- | --- |
| M05 | cmvdmf87y043t9xhgdo28uftr | f4d0b48d | 01a1587f-7e05-7df0-a533-d3fb2a02beb6 |
| R6_ARBURG | cmvdmf880044h9xhgr7zjz83d | f12e3ac3 | 01a1587f-59e8-7aa3-a74b-ad944ffaa185 |
| R6_BOLE | cmvdmf880044j9xhgfq8r9py1 | f12e3ac3 | 01a1587f-60a4-78b3-93ba-de4f05d21a97 |
| R6_DEMAG | cmvdmf880044l9xhgihg4hu8o | f12e3ac3 | 01a1587f-89e7-78e3-a840-f066bd4bd444 |
| R6_FANUC | cmvdmf880044n9xhgpxl58qyi | f12e3ac3 | 01a15880-856e-75c0-9658-d85b0a62e03c |
| R6_NISSEI | cmvdmf880044p9xhg6z3mtzlv | f12e3ac3 | 01a15880-ea19-7d60-b8e5-4fef1a9ae957 |
| R6_YIZUMI | cmvdmf880044r9xhgc8z15d8w | f12e3ac3 | 01a15881-088a-7ff0-9649-b183aaa8bb3a |

七个 Worktree 存在、干净、HEAD 等于保存候选，七个原生 Session JSONL 文件都存在，且 implementer participant 上的 Session 身份可解析。`TaskGraphExecution.sessionId` 为 null 不代表原生 Session 丢失，实际续接从原实施 TaskRun 的 participant 元数据取得。

七个节点的 repair、format、platform、integration 已用次数均为 0；原上限分别为 2、1、2、3。本轮没有刷新。恢复后的尝试仍计入既有预算，不承诺免费重试。

## 环境根因与当前实测

### 必需技能仍未批准给这两仓

当前有效项目授权能由原确认人身份解析，policy hash 与各自迁移批准事件、原 runtime pin 一致：

- Reader `72c9ab62c07f4c72c67194c1392aa73c152cc47d8ff473f3d579e0d1d2c4c273`，只读根为主仓 `.venv`、`ground_truth`，没有 runtime 技能声明。
- Mold `000525ee0ca25b353d1617a006f060e642fa2168fe77c167c2dc4c0da3e8ab24`，批准 backend `.venv`、Reader `ground_truth`、固定 Playwright 模块和 Chrome，runtime 只有 browser。
- 七个当前候选均没有已跟踪 `.agent-platform/runtime.json`，因此不是仓内声明覆盖了新技能，而是这两仓的宿主登记从未加入该技能资源。

宿主技能包实际存在于 `/home/hello/.local/share/pstack-claude/plugins/pstack/skills/poteto-mode`，包摘要为 `c0c9282e8d96eb9f7ef1787778c761824418577d9582dceb0e7558cd0cf16c81`。旧票规定的 `/home/hello/.codex/skills/poteto-mode` 是指向它的链接。

使用当前唯一 Bubblewrap renderer、严格只读路径、真实候选工作区，七次探针均看到 `SKILL.md false`、`scripts/check-playbooks.mjs false`、`packageEntries 0`。宿主安装正常，旧授权并未包含链接目标。现有 runtime 声明也不会要求完整技能预检，不能把没有 skills 的预检成功记成技能可用。

必须审批这个精确真实包目录和固定摘要，完整包包含 SKILL、Codex 工具映射、脚本及引用的 playbooks，再在实际沙箱中通过完整包预检。不能递归放开整个 pstack、HOME 或任意链接目标。本轮没有额外挂载该目录来制造成功。

### Python 与浏览器可用，但真实 OCR 尚未就绪

- Reader 和 Mold 的 Python 解释器/环境配置 identity 与原 pin 相同，真实只读沙箱中 pytest 可导入；Mold FastAPI 可导入，Reader PaddleOCR 2.7.3 可导入。
- Mold 的固定 Playwright 模块与 Chrome 摘要匹配，真实沙箱启动 `147.0.7727.137`，页面 title 读回成功。
- Reader 原候选 `hmi_service.py` 使用 PaddleOCR 默认模型缓存，不是主仓尚未提交的 v6 改动。当前技能/模型授权不能因主仓变动自行切换模型。
- 原沙箱不可见 `/home/hello/.paddleocr/whl`，临时 HOME 下也没有该缓存；Reader 没有 OCR 权重声明，Mold 也没有 Reader OCR 资源声明。宿主目录存在不能代替沙箱可用证明。
- 未启动 OCR 服务、下载模型或跑真实识读。这里已证明模型缓存没有绑定，尚未证明具体任务一定走哪条默认模型下载分支。真实 OCR、GPU/CPU 可接受性、模型 SHA、初始化和样例识读仍须在批准后的隔离准备中验证。不能用导入成功当识读成功，不能为消除错误静默联网下载另一版模型。

同一工作区重复安装工具不能解决上述授权缺口。应选择与原候选兼容的既有模型、明确最小只读资源和缓存输出，并核对原业务合同是否允许该执行设备。

### 跨仓范围与固定输入

双方原批准 `extraRepositories` 都是对方主仓只读。调用现有只读准备检查通过，没有申请额外仓写权限。Reader/Mold 主仓都有原有未提交材料，主仓 HEAD 也不同于路线交付，不能拿主仓当前 `hmi_service.py` 或未提交合同冒充 R05 固定包。

应继续从账本已集成 SHA/Git 对象取固定 Reader 包和 raw-contract。M05 使用 R05 交付，后续 M6 消费各自 R6 新包。固定候选/集成对象均可读取。完整 API、字段语义和数据包兼容性须由真实实施和独立验收证明，本轮不凭文件存在宣告一致。

## R6_YIZUMI 单独诊断

复用生产资料读取函数和相同 bot 身份，读取原批准 `training` 源。返回 HTTP 200、业务码 `1254018`、`InvalidFilter`，原始 message 明确为 `There is no option '伊之密' for the field '品牌'`；英文 `YIZUMI` 同样失败。

字段元数据读取成功，品牌为多选字段，当前选项是：伯乐、佳明、日精、德马格、发那科、沙迪克、阿博格、百塑。没有伊之密。当前平台包装把这种筛选错误统一描述成“核对应用和资源授权”，容易误导为沙箱权限问题。此处没有修改包装代码。

对照查询伯乐、德马格、阿博格、发那科、日精均成功，各返回第一页 20 条且 hasMore=true。伯乐及德马格各选一张批准图片，实际下载至内存，MIME/大小验证成功并记录 SHA。没有声称这些样例已完成控制器/版式语义核实，也没有扫描所有分页或全部图片。

YIZUMI 需要确认资料源：是在另一个表、品牌名称录错，还是尚未提供该品牌资料。不能改用佳明等品牌来替代，更不能自行添加多选项。已有授权仅含 `成型条件-储料/冷却` 图片字段；如需要射出/温度等其他字段，也须明确来源和授权，不能为了凑覆盖率自动读取全表附件。

## 节点分类

分类允许重叠，环境准备不能代替资源授权。

| 分类 | 具体节点 | 处理 |
| --- | --- | --- |
| 当前可直接安全恢复 | 无 | 技能缺口仍可复现，尚无本次实际恢复授权 |
| 需要精确资源重新授权与环境准备 | M05、全部六个 R6 | 技能包；按实际识读路径核对 OCR 资源及预检，保留已有 browser/Python 身份 |
| 另外需要人工决策 | R6_YIZUMI | 确认真实品牌资料来源；若换源/字段，另行批准范围 |
| 前置未满足 | 全部六个 M6、M07 | 等原依赖通过，不手工放行 |
| 已交付，保持现状 | R01、R02、R04、R05、M01、M02、M03A、M03B、M04C、M04T | 使用已有固定交付，不重新实施 |
| 已证实无法恢复 | 无 | 未发现七个暂停节点保存点或 Session 丢失；不等于全部业务材料充足 |

R6_BOLE、R6_NISSEI 等报告“指定测试入口不存在”，原 Ticket 明确要求实施者创建这些行为测试。它是尚未完成的业务工作，不是需要平台伪造测试文件解决的环境故障。

## 最小恢复方案，待批准

### 先完成资源准备，不改旧批准快照

1. 为两仓给出精确技能/模型清单、摘要、现有 Python 与 browser 的兼容结果，由宿主授权人批准。按原业务范围准备，禁止读取未经批准的新表/附件字段。
2. 原 runtime pin 不追加字段、不改哈希、不覆盖。新资源只能在受控后续 claim 中固定，原候选、Session、预算继续保留。
3. 这里有一个必须先处理的兼容边界。`legacy-scope.ts` 会拒绝把含新 runtime 声明的 scope 直接迁入旧 claim；`runtime-continuity.ts` 也会拒绝 claim 内 policy/runtime 改变。这是有效保护，不能删掉。
4. 现有“资源批准 → 新 claim → 固定新运行资源”需先证明能通过既有准备/恢复入口完整串联。新 policy hash 对应的 scope 必须在派发前具备，不能先点恢复让 Coordinator 抢跑，也不能先换全局配置让旧 pin 突然失效。若现有入口不支持这种绑定顺序，应先停在准备阶段，提出仅补这个交接边界的小改动及回归，另获批准。不能声称现在已有一个命令可无风险完成资源升级。
5. 受控新 claim 的完整技能、OCR 初始化和真实样例检查通过后，再接受实际恢复批准。运行身份记录资源 hash、TaskRun、Session 和 Manager backend identity；只读探针不能代替实施。

### 首批恢复三张已批准的独立 Ticket

| Ticket | 业务成果 | 为什么选它 |
| --- | --- | --- |
| M05 | 管理员接纳 Reader 固定包，普通用户预览、保存并重开新页 | 依赖已过，浏览器/API 环境已有直接检查；覆盖跨仓消费 |
| R6_BOLE | 既有伯乐控制器一个新增物理版式或已有能力回归，真实固定包与样本证据 | R05 已过，原 Session 在，资料查询和一张图片下载成功 |
| R6_DEMAG | 德马格一个控制器/版式的识读缺口、固定包与开发/保留样本证据 | 与 BOLE 无依赖，原 Session 在，查询和图片下载成功 |

三票分别写现有专属 Worktree，不写对方主仓。当前 `claimNode` 对额外仓 read/read 不互斥；仓内整合使用 repository lock 串行提交，不串行所有编码。Coordinator 上限 4，实际启动仍取决于当时其他工作占用，不能预先承诺三个槽一定空闲。

这次恢复应继续使用 `scheduleImplementationRecovery` 及其原消息身份/授权入口，writer exited、候选/基线、旧 TaskRun 完成、claim/revision CAS、幂等 requestId 和预算都保留。该入口令执行重新 ready 并产生后续 claim，不是直接更新数据库状态。

`implementationConversation` 从原实施 participant 取 Session，Review 的会话不接管实施。新 Codex graphExecution 经 `runner-harness.ts` 进入 Sandbox Manager；Registry 使用同一 control。Manager 根进程 close 不代替 GraphWriter nonce 后代退出证明。续接时要记录真实 resumeThreadId 与旧 Session 相同，不以存在本地 JSONL 文件当成续接验收成功。

### 恢复后的业务验收证据

- 每票记录 Worktree HEAD、候选、TaskRun、原 Session 续接身份、Manager identity、Writer 释放、CAS revision 和预算变化。
- 原飞书 Topic 中由用户补一项材料，实施 Agent 直接接收并继续，回读新进度消息，确认没有转入只读 Followup 或平台默认文案。
- BOLE/DEMAG 对真实图和开发/保留样本运行识读，给 page_id、控制器/版式、逐字段原始结果、明确不支持项及固定包 SHA。错误品牌与五段/三段等语义不能凭模型臆测。
- M05 使用账本 R05 固定包，真实 Reader 调用、API 权限/等值/目的地/GET 和 1440/390 视口保存重开留证。隔离数据库，不能写共享数据库。API、浏览器和识读分别报告。
- 平台行为检查与独立验收都通过才算交付。M05 与相应 R6 通过后，应自动放行 M6_BOLE/M6_DEMAG；其他品牌的 M6 继续等自己的 R6，M07 等全部 M6。
- 后继的自动放行可能产生实际执行。本次没有授权任何这一流程。后续请求批准时需明确首批恢复和按原图自动推进的边界，不能恢复后再默认为用户只批准三张或默认批准全部业务。
- 交付报告给实际页面/API、样例与测试、已实现/不支持功能、完成和阻塞节点，不能只报 passed 数量。

本阶段到此停止，等待对资源准备及实际恢复范围的批准。
