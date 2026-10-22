# 让获批 Ticket 按正常 Agent 对话推进

状态：核实后的修复方案，待审阅；本轮没有修改业务代码、部署或恢复生产任务。

源码基线：`oss-prep@6a270d2`。前次调查：[528 报告](528_REPORT_20261022_PersistentTicketAgentArchitectureReview.md)。本轮按 `unslop` 整理，保留能落实到行为、源码和证据的结论。

## 1. 产品要求

用户确认路线和 Tickets 后，平台按真实依赖分配任务、创建或复用任务房间。独立 Ticket 并行，有真实依赖的 Ticket 等前置交付通过。

每个房间的 Agent 接到 Ticket、文档和当前工作区后，按正常对话方式调查、找资料、编码、调试和测试。有疑问由 Agent 自己问用户；有其他工作就继续做，确实需要答案时再等待。用户回复进入原会话，不要求另一次恢复审批。

平台提供总览卡，展示实际进展、Agent 的原问题、交付结果和验收结果。用户可以在卡片回答或打开原话题。平台把回复送回原 Agent，不替它编造问题或回答。

正式交付后，平台负责受控集成、独立验收和后继放行。验收发现范围内缺陷，交回原 Agent 修复。Sandbox、权限、单 Writer 和候选 CAS 是执行保护；普通工程错误不撤销 Ticket 的工作资格。

## 2. 这一轮实际核实了什么

证据位于 [`docs/evidence/persistent-ticket-agent/verification-20261022/`](../evidence/persistent-ticket-agent/verification-20261022/)。没有把宿主目录可读当成沙箱可读，也没有把 Agent 的描述直接当成平台事实。

### FANUC 原图存在，错误来自查询参数

当前批准的 `training` 来源按“品牌”筛选。Agent 查询 `Z036` 时，飞书返回1254018，原始原因是 `InvalidFilter`，品牌字段没有Z036选项。`table-data.ts` 却把它统一提示成“请平台核对应用和资源授权”。

使用同一批准范围查询“发那科”，第二页找到原记录 `recuQJJFYYxREp`。下载储料/冷却字段的原图为4614726字节，SHA256为：

```text
3c37a3f27ba80db8846375478e5dd068bcf195a918fd5a8439a553ca2bfad981
```

与失败测试要求的旧原图完全一致。没有扩大来源、字段或权限，没有用替代图冒充原图。此前“缺图/可能需扩权”的描述应以本次实测更正。FANUC的其他回归缺陷仍须由原Agent修复并复验，找到图片不等于整票通过。

### Mold 的主技能包可读，包外叶技能不可读

按 M6_ARBURG 原 Runtime Pin 的批准目录，用真实 Sandbox Manager/Bubblewrap 做只读探测：

- `poteto-mode` 包70个文件全部读取成功，项目校验脚本退出0。
- `how`、`architect`、`principle-prove-it-works`、`principle-model-the-domain` 四个包外叶技能，宿主有文件，沙箱内均为ENOENT。
- 探测源码目录不可写，没有扩大挂载或启用宿主执行回退。

这是“可见工具与实际装配不一致”的具体问题。不能再统称poteto-mode整体缺失。必需工具依赖应由共享环境准备在启动前处理；适用性由Agent判断。不能递归放行任意symlink目标，也不能把平台工具缺失包装成用户必须补材料。

### 所报告的 Mold 基线冲突不符合当前账本

实际HEAD、账本candidate和workspaceBase都为 `2a3bf035f06030f50027691baf3ad26907eca523`。Agent报告拿来比较的 `f45ff824` 属于 M6_DEMAG 的另一项交付，不能代替 M6_ARBURG 当前工作区的基线。

独立Worktree落后于共享集成分支的新HEAD，不自动构成错误。当前报告不能作为reset/checkout原工作区的理由。尚未唯一还原Agent从哪段历史上下文取得该比较要求；下一轮应核对当前Stage Request实际交付给Harness的身份字段，而不是补一段“不要比较错”的Prompt。

### 事务超时存在，具体单次慢点不能伪报已定位

线上保存了5000ms事务执行5499ms后失效的错误。源码在事务里执行进程扫描、Git/文件检查及部分全局Prisma查询。

本轮对 M6_ARBURG 真实Writer观察连续测得706、719、738ms，均证明旧Writer已退出。这说明观察有实际成本，但不能据此断言那次5499ms超时唯一由某次扫描造成。缺少历史逐段trace，下一轮用隔离故障回放验证事务边界；不靠调大timeout掩盖它。

### 总览卡在更新，已有回复通路

当前账本重建卡片的hash与最近一次成功发布回执一致；没有发现“账本已变而这张卡没有更新”的证据。现有总览已有选择任务、输入回复和“发送给原Agent”的表单。

源码回调核对卡片、操作者和任务归属，将同一用户回复写入原房间及 `conversation-inbox`。本轮隔离T3回归通过，覆盖重复提交、串任务、暂停期间保存回复和过期控制拒绝。没有向生产卡片发送测试回答，也未冒充真实用户点卡验收。

现有展示仍会截取失败文本或长摘要，不保证优先展示Agent的准确问题。这是呈现方式需要改，不必另建聊天系统。

### 日精的验收要求不能省略

当前失败测试要求与开发图不同的TACT5原图及独立真值。把开发图、裁剪图或其他控制器图改名为保留样本不能满足要求。

读取 `hmi_finetuning` 的申请确实超出当前批准目录，是补证的一种路径。本轮没有读取该目录，也没有授权它。原Agent仍可搜索已批准来源，不能把“尚未允许这条新路径”解释成整个平台都必须停止。

## 3. 平台应该负责到哪一步

```text
Issue Tracker依赖 + 已批准Ticket
    ↓
现有Coordinator分配并发槽、创建/复用房间
    ↓
当前Ticket输入 + 合格前置产物 + 当前候选 + 原话题消息
    ↓
原Agent / 原Session / 独立Worktree
    ├─ 自主调查、找资料、编码、测试、修复
    ├─ 自己提问 → Topic与总览展示 → 用户回复回同一inbox
    └─ 交付 → 受控集成 → 独立验收 → 完成通知与后继释放

共享环境准备：落实已批准的工具和资料访问
Sandbox Manager：准备沙箱、启动/停止进程、退出证明、清理
```

前一代frontmatter和“下个Session Prompt”的接力，在这里由Issue依赖、固定交付、账本和原会话输入承担。它们决定下个Ticket何时开工；不会把当前Ticket的普通问答变成一次新的业务审批。

## 4. 最小修复顺序

### A. 先让 Agent 拿到准确的输入和可用工具

| 文件 | 要改的行为 |
| --- | --- |
| `src/lib/project-capabilities/table-data.ts`、`runtime.ts` | 保留批准资料接口的真实错误原因；InvalidFilter作为可纠正参数反馈Agent，不统一说缺权限。来源信息明确查询字段，空查询浏览继续可用；不新增来源或图片字段 |
| `src/lib/task-graph/runtime-preflight.ts`、`skill-resource-preflight.ts`及现有资源声明 | 对实际需要的工具依赖进行Discover、宿主Authorize、Mount、Verify。已批准包与必需依赖预检覆盖真实沙箱。尚未授权的目标保持不可读；不在每张Ticket里临时放开目录 |
| `src/lib/acpx/runner-harness.ts`、`prompt.ts`、现有 `stage-execution-request.ts` | 单一传递当前candidate、workspaceBase和前置输入。正常首次/Resume共用既有构造。共享集成HEAD、工作区候选和资源版本分别有明确用途，保留W001校验。先核对实际输入，不预设W001本身有错 |

不增加Prompt条款来教Agent绕开错误工具。不把整个工作区根、pstack父目录或其他Ticket目录挂进沙箱。平台工具安装与宿主授权应由宿主处理；新增业务资料范围仍需原授权入口。

### B. 收敛调度，不再让普通故障进入专用人工恢复通道

| 文件 | 要改的行为 |
| --- | --- |
| `task-graph/implementation-result.ts`、`execution-progress.ts` | 普通工具错误、缺材料、测试失败作为原Agent工作/等待的一部分。模型自报blocked不等于授权失效，也不能只凭模型自报permission就替它决定用户须扩权 |
| `task-graph/coordinator.ts` | 复用现有调度入口；批准有效、相关条件已实际恢复、Writer安全退出后，从原合法保存点安排一次工作。历史attention也采用同一判断，不按节点名写恢复例外 |
| `task-graph/conversation-recovery.ts` | 临时失败不能永久消费继续请求；安排工作成功后才完成消费，使用已有幂等和CAS防重，不新增调度器 |
| `task-graph/writer-snapshot.ts`、`runtime-continuity.ts`及现有结果提交点 | 慢观察和准备放到事务外，短事务核对批准/候选/claim/revision/Writer绑定后CAS。执行边界保持撤权和资源身份核验 |

```text
Agent一轮结束 → 保存现场
有可执行工作或新输入 → 现有调度入口 → 原Session继续
Agent确实需要答案且无其他工作 → 保留资格等待
用户回答 → 原inbox → 原Session继续
平台准备故障 → 条件变化后实际重验 → 同一调度入口
真正扩权/Writer unknown/候选漂移 → 停止相关危险操作
用户明确暂停 → 保持暂停
```

工作资格持续有效，不表示模型无限循环或Writer永久占用。已有成本限制和无进展保护保留，旧计数不清空。平台条件未变时不反复重启模型；条件恢复后也不能仅凭一个新requestId跳过安全核验。

### C. 总览卡做成观察和干预入口

复用 `task-graph/overview.ts`、`run-reply-card.ts`、现有消息账本和回调，不新增通知或问题状态机。

每个Ticket显示：当前工作的一句话、最新Agent原问题、能否继续其他工作、当前交付/验收结果、最后进展时间、原Topic入口。用户在对应问题旁直接回答，答案仍进原Agent的inbox。

“有一条问题”不等于Ticket暂停。平台故障单独显示平台在处理什么，不伪装成Agent向用户索要批准。实施完成和独立验收通过分别通知；完成后对应后继自动开工。

## 5. 必须保留的保护

- 新资料或目录未授权、用户撤权和明确暂停继续生效。
- Sandbox Manager、网络/文件隔离、单Writer、旧事件隔离、claim/revision及候选CAS保持原样。
- 交付必须有真实产物和证据，独立验收不被Agent自测代替。
- M6_YIZUMI输入含未通过FANUC历史的检查不能删。优先完成FANUC；如要隔离独立交付，必须形成合格固定候选，不能伪造原输入hash或改批准依赖。
- 不引入数据库新状态机、后台Agent、第二套Scheduler、通用Prompt框架或更多手工恢复协议。

## 6. 验收看用户能否少操作

1. 重放本次Z036错误查询，Agent拿到准确字段/错误反馈，改正查询并获取SHA匹配原图；用户无需补图或批准恢复。
2. 当前技能依赖在批准范围内能实际使用；缺少必需平台工具在模型开始前被准确发现；不递归放行symlink，越界仍失败。
3. 独立Worktree与共享集成HEAD不同仍可实施；当前候选真正漂移时W001/CAS必须拒绝。
4. Agent提问后能继续其他工作；确实等待时，用户在总览回答一次，同一Session收到一次并继续。
5. 模拟事务超时、Writer暂时unknown，原输入和继续请求不丢；真实双Writer、撤权、旧候选和未验收输入仍拒绝。
6. M6_BOLE旧容量失败在新预检通过后自动继续，不要求再发resume，不清空预算。
7. 两个独立Ticket有真实执行时间重叠；范围内验收缺陷自动回原Agent；通过后对应后继自动领取。
8. Reader真实图片→识别API/CLI与固定合同一致；Mold真实页面→编辑、保存、关闭重开和API回读一致。最终展示功能和未决问题，不只报passed数量。

本轮只验证当前事实和已有卡片回归。以上修复后的完整行为尚未实现或通过，不能把本报告当成验收结论。
