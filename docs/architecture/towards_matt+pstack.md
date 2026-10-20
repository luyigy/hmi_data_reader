# agent-platform-v2 架构梳理与演进建议

我重新检查了你的 `agent-platform-v2`，这次以 GitHub `oss-prep` 分支的 `6f45b6d` 为基线，重点阅读了任务编排、Agent 执行、话题对话、Architect、验证以及最新的工作流设计。

我认为现在最重要的不是继续修补某张 Ticket，也不是立即增加 Gardening Agent，而是明确你想要的平台究竟是什么、现有哪些能力、缺少哪些关键机制，以及如何在不破坏现有功能的情况下整理架构。

而且，你对任务话题的澄清非常重要：

任务话题是人和执行 Agent 沟通的界面，不代表每个任务都需要完全无人值守。

这一点应该成为你平台的明确产品原则。

## 一、先定义你真正想要的系统

我理解你的目标是将 Matt Pocock 的需求工作流与 pstack 的工程工作流结合，并由 `agent-platform-v2` 负责执行、协调、权限和持久状态。

这是我建议的最终架构。Architect Inspector 和 Gardening 的完整自动化仍是待建设能力。

这里有三个非常重要的边界：

- Matt 负责实施前决定做什么。
- pstack 负责实施时如何保证工程质量，并让仓库逐渐改进。
- 平台负责谁来执行、在哪里执行、何时恢复、如何协调和展示结果。

而飞书话题仅仅是人机交互入口：可以提问、纠正、提供材料、暂停和继续。Agent 不需要因为创建了话题就进入独立的全自治模式。

## 二、现在的代码库到底是什么形状？

从实际代码来看，你不是只有一个 Agent，也不是简单的 Skill Runner。你已经开发了相当完整的执行平台。

目前核心结构可以简化为：

当前代码结构的概念地图

agent-platform-v2/ ├── src/ │   ├── app/ │   │   └── api/            HTTP/API 入口 │   │ │   └── lib/ │       ├── task-graph/     Ticket 编排与执行生命周期 │       ├── acpx/           多 Agent 执行引擎 │       ├── harness/        Codex / Kimi 等适配层 │       ├── feishu-\*.ts     飞书消息与交互 │       └── 其他服务模块 │ ├── prisma/                 数据模型与迁移 ├── config/                 资源及运行配置 ├── scripts/                后台任务与管理入口 ├── tests/                  自动化回归 ├── docs/                   规格、架构及证据 └── skills/                 仓库内的部分 Skills

这是按职责整理的视图，不是逐文件的完整目录树。

### 各部分实际承担的职责

| 模块                             | 现在做什么                 | 我的判断         |
| ------------------------------ | --------------------- | ------------ |
| `task-graph`                   | Ticket 依赖、派发、检查、集成、恢复 | 能力多，但职责过于集中  |
| `acpx`                         | 统一运行多种 Agent Harness  | 值得保留的基础层     |
| `harness`                      | 具体 Agent 的进程、事件、沙箱适配  | 应与业务工作流分离    |
| `conversation-*`               | 任务话题与原执行者会话接续         | 符合你澄清后的意图    |
| `architecture-review`          | 固定提交的独立架构复核           | 已存在，但主要是阶段式  |
| `execution-progress`           | 执行阶段、失败、预算与恢复状态       | 非常重要的权威状态机制  |
| `docs/evidence/*/gardening.md` | 保存根因、Wire 和验证记录       | 已有真实案例，尚未自动化 |

现在最大的问题是：

`task-graph` 同时承担了工作流、执行过程、验证、对话、Git 生命周期、恢复及 Issue 对接等大量职责。

例如，`conversation-followup.ts` 本身就会涉及 Prisma、Agent Runner、Git Worktree、Writer Ownership、Feishu 权限和消息投递。

这不一定说明功能实现错误，但确实说明多个架构边界高度耦合。未来 Agent 修改一个对话功能，很容易触碰任务状态和执行权限。

所以你觉得代码越来越难理解，是有客观基础的。

## 三、Matt Pocock 到底整合得怎么样？

我会把它判断为：已经具备部分实际运行链路，但还没有一个可审计的端到端工作流合同。

你已经有 Spec、Issue Tracker、依赖、路线提审、执行快照等机制。

例如，`prompts.ts` 已经要求实施 Agent 使用冻结 Spec、当前 Ticket 和批准范围。

但还有两个方面应该补强：

第一，从最初需求讨论到最终 Spec、Tickets 的决策来源链是否完整记录，例如用户已经回答了什么、哪些选择仍未确定、某个 Ticket 为什么这样拆分。

第二，Coding Agent 启动时，是否能够明确知道哪些是来自 Matt 对齐的批准决策，哪些只是 Agent 的实施建议。

我建议最终使用这样的契约：

```
Alignment Result
├── 用户目标
├── 已确认决策
├── 未决问题
├── 范围限制
├── 关键验收标准
└── Spec version
          ↓
Ticket
├── 来源 Spec
├── 本片目标
├── 依赖
├── 允许修改范围
├── 验收条件
└── 已批准角色和执行模式
```

不需要再增加第二套 Ticket 数据库。可以继续让 Spec 和 Issues 做编写来源，平台仅保存获批执行快照及引用。

## 四、最重要的缺口之一：实施过程中的 Architect Inspector

这里我很同意你的关注点。

当前 `architecture-review.ts` 的主要流程是：

1. Implementation 形成固定提交。
2. 平台启动独立架构复核。
3. Architect 检查模块边界、接口和影响面。
4. 失败则进入回修流程。

这属于 Post-implementation Review（实施后的架构复核）。

你想要的是另一种能力：

Implementation 正在发生时，Architect 就能识别越界、错误方向、架构侵蚀，不必等 Coding Agent 写完全部代码。

两者应该结合，而不是互相替代。

### 建议采用三个层次

Level 1

实施前：Architecture Contract

Architect 根据 Ticket 与仓库架构，定义允许修改的模块、禁止的依赖方向、需要保持的不变量，以及必须通过的检查。

Level 2

实施中：Boundary Inspection

对当前 Worktree 的增量改动进行检查。先用确定性规则发现跨目录、越权 Import 或状态写入，再对有风险的改动调用只读 Architect 审查。

Level 3

集成前：Independent Review

保留现有独立架构复核，检查整个固定提交及跨模块影响，并与最终测试和验收结果共同决定是否集成。

### 为什么不能简单地“每隔一分钟启动一个 Architect”？

因为你使用的是多 Agent、多 Worktree 编排系统。

如果 Architect 直接进入同一个可写目录，可能与实施 Agent 冲突。如果 Architect 每次重新阅读整个仓库，又会浪费大量 Token，产生重复意见。

所以更合适的是 基于代码变化的只读增量检查。

例如：

```
Coder 修改文件
      ↓
Git diff / 文件变更集合
      ↓
Boundary Checker
      │
      ├── 没有越界
      │     └── 继续编码
      │
      └── 发现高风险变化
            ↓
       Architect Inspector（只读）
            ↓
       生成具体整改意见
            ↓
       Coder 修正后复验
```

触发时机我建议先选择“每次实施检查点或阶段性提交”，而不是监视每个文件保存动作。

尤其值得检查的是：修改了 Ticket 范围以外的模块、增加跨边界 Import、绕开状态所有者、改变公共数据结构或扩大接口契约。

其中可以用机器规则确定的问题，应尽量由静态检查立即拦截。Architect 模型只处理需要工程判断的情况。

这才是把 pstack 的 Architect 原则变成真实可运行机制。

## 五、第二个关键缺口：真正的 Gardening

目前你已经有两份很有价值的案例：

- `docs/evidence/m02-s01/gardening.md`
- `docs/evidence/runtime-continuity/gardening.md`

它们记录了根因、修复、测试、限制和真实接续结果。

但它们现在主要是工程报告，而不是平台能够持续使用的规则系统。

Gardening 真正需要的是让一次教训形成可复用、可检测、可查询的工程资产。

例如：

Gardening 完整反馈回路

检测到重复错误 / 架构违规

Gardener 分析根因

软性教训

Skill / Playbook 改善

硬性 Wire

Lint / 测试 / 架构边界

反向验证：旧错误必须失败

未来 Ticket 自动使用约束

我建议第一版 Gardening 不需要一个新的常驻 Agent。

只需要在现有任务生命周期中增加一个非阻塞的后处理步骤：

`Ticket 完成或回修结束 → 提取失败和修改证据 → 对照已有教训 → 生成 Gardening Proposal → 审核是否需要新增 Wire。`

关键是 Gardening 失败不能导致业务 Ticket 再次暂停。

而且，自动提出 Wire 不意味着自动修改所有仓库。修改 Lint、测试或模块边界同样属于代码变更，应该使用现有的受控执行和验收机制。

Gardening 的价值应该通过三种实际证据来衡量：是否找到过重复根因、是否成功验证新增约束，以及未来是否真正拦截过同类违规。

## 六、代码应该如何重新组织？

我不建议你立刻全面重构 `src/lib/task-graph`。

但也不建议继续在这个目录里无限增加平铺文件。

比较合理的目标是按 业务能力边界（Feature / Bounded Context） 逐步组织，而不是单纯按 Agent 角色创建目录。

建议的目标架构

src/ ├── features/ │   ├── alignment/             # Matt │   │   ├── decisions/ │   │   ├── specs/ │   │   └── ticket-planning/ │   │ │   ├── task-orchestration/    # 平台核心 │   │   ├── domain/ │   │   ├── scheduling/ │   │   ├── recovery/ │   │   └── application/ │   │ │   ├── task-conversation/     # 飞书任务交互 │   │   ├── inbox/ │   │   ├── sessions/ │   │   └── delivery/ │   │ │   ├── engineering-quality/   # pstack │   │   ├── architecture/ │   │   ├── verification/ │   │   └── gardening/ │   │ │   └── issue-tracking/        # GitHub / Gitee │       ├── providers/ │       ├── sync/ │       └── projections/ │ ├── infrastructure/ │   ├── agent-runtime/         # ACPX / Harness │   ├── sandbox/ │   ├── git-workspace/ │   └── messaging/ │ └── app/                       # API / UI

这是未来架构的概念设计，不是建议一次性创建所有这些文件夹。

这里最重要的不是目录名称，而是依赖方向。

例如，`task-conversation` 可以提交用户输入给 `task-orchestration`，却不应该自己决定将某个 Execution 从 `attention` 改成 `ready`。

`engineering-quality` 可以向协调器提交架构审查结果，却不应该绕过 `ExecutionProgress` 直接修改运行状态。

`issue-tracking` 可以投影执行状态，却不应该决定某个 Ticket 是否真的通过验收。

这些职责边界一旦确定，就能通过 TypeScript 接口、模块可见性、Lint 和架构测试转化成真正的 Wire。

### 不要从搬文件开始

我建议第一步只建立一个 Architecture Map，包括：

- 每个现有模块负责什么。
- 哪些文件对外提供接口。
- 哪些模块允许修改 Task Graph 状态。
- 哪些模块只能读取状态。
- 当前跨模块依赖和循环依赖。
- 哪些文件同时承担多种职责。

然后只选择一个边界做试点，比如 `task-conversation` 与 `task-orchestration`。

因为最近你刚修改了会话逻辑，这个位置特别适合建立规则：

对话模块可以接收和投递消息，但执行推进必须通过统一协调器。

这是一条非常具体、能写成自动检查、并能防止以后重复犯错的架构 Wire。

## 七、我建议的实施路线：五个可独立验收的 Slice

S01 — Architecture Map（只读审计）

生成当前代码模块地图、职责矩阵和依赖关系，找出状态所有权与越界调用。明确当前 Matt、pstack 和平台编排的实现入口。

验收：能从需求对齐一直追踪到 Ticket 执行、架构复核、验收和 Issue 回写，标注真实代码文件，不修改运行逻辑。

S02 — Architecture Contract + Boundary Wire

从现有 `AGENTS.md`、实际代码边界及获批 Ticket 导出一个最小架构合同，禁止特定跨模块调用。

验收：故意让对话模块绕过 Orchestrator 修改执行状态，静态检查必须失败；恢复合法调用后通过。

S03 — Incremental Architect Inspector

在实施中的稳定检查点运行只读增量检查，检测 Ticket 范围外改动与违反模块边界的调用。必要时由独立 Architect 进行语义审查。

验收：Coder 越界时，在集成前获得带文件、规则、证据和整改建议的报告；同一个检查点不会重复派发审查；审查不改写 Coder 工作区。

S04 — Gardening MVP

复用历史 TaskGraphEvent、失败检查和 Git 证据生成教训记录，支持复用现有 Wire 或提出新增 Wire。

验收：用 M02 和浏览器资源继承故障生成两份报告，能追溯其反向验证测试；后处理失败不阻塞后继 Ticket。

S05 — 渐进式模块整理

基于 S01 的实际依赖图，将一个完整功能边界迁入新目录，通过公开接口减少耦合，删除旧路径而不是长期保留双实现。

验收：任务话题、状态恢复、跨仓并行和验收回归与迁移前一致；架构边界检查通过。

这里 S01 是基础；S02、S03 共同保护实施过程；S04 负责长期改进；S05 在这些约束下逐步整理代码。

其中最重要的一点是：不要让架构重构再次变成一个巨大的 Ticket，让 Agent 连续改几十个模块，最后又因为验收复杂而卡住。

每次只改变一个明确边界，做完就测试、观察、合并。

## 八、现在最应该交给 Coding Agent 的是什么？

我建议先从 S01 开始，但要求它不仅输出一篇普通架构文档，还要生成可以指导后续重构的真实调用图与边界清单。

你可以直接复制下面这份指令：

# S01：agent-platform-v2 架构地图与 Matt/pstack 整合审计

## 目标

对现有代码进行只读架构审计，帮助开发者理解当前代码库，并确定未来的模块边界。

本次不进行大规模重构，不新增 Agent 或调度器，不改变生产任务。

## 产品原则

1. Matt Pocock 的 Skills 负责实施前的需求对齐、Spec、Ticket 生成和审批。
2. pstack 负责工程实施过程，包括 Investigator、Architect、Verifier 与 Gardening。
3. agent-platform-v2 负责多 Agent 编排、执行、会话、权限、Worktree、状态恢复和可观察性。
4. 每个 Task Topic 是用户与原执行者的交互入口，不要求完全自治。用户应能在话题内提问、提供材料、纠正方向和请求继续。
5. 任务执行状态由统一协调器管理；任务对话、Issue Tracker 和验证模块不能各自维护独立的执行状态权威。

## 审计范围

- Matt 的 Skill 加载与执行入口，以及 Spec → Tickets → Approved Route 的真实调用路径。
- Task Graph 调度、ExecutionProgress、Writer Ownership、Agent Harness 和恢复机制。
- Task Topic Inbox、原生 Session 接续与飞书消息交互。
- pstack Architect 当前何时触发、检查什么、其结论如何进入回修。
- verify Skill 与独立验收是否真正执行检查。
- Gardening 当前保存了哪些教训，哪些是真正的机器约束，哪些只是文档。
- 各模块之间的实际依赖、循环依赖、重复入口及可能的状态越权。

## 必须交付

1. **Architecture Map**：当前目录结构、模块职责、关键入口和依赖关系。
2. **Workflow Trace**：从一次用户需求对话到 Ticket 完成的真实调用链，引用源码文件和函数。
3. **Capability Matrix**：Matt/pstack 每项能力的已实现、部分实现、尚未实现状态及证据。
4. **Boundary Violations**：实际发现的跨模块职责混淆、状态多写入口和复杂耦合，不凭目录位置猜测。
5. **Target Architecture**：渐进式目标目录及公开接口设计，不提前创建空目录。
6. **Migration Plan**：优先三个最小改动，每个都具有可执行回归、失败回退和明确验收。
7. **Architect Inspector / Gardening MVP**：基于现有执行生命周期提出最小接入点，不创建第二套状态机或调度器。

## 约束

- 只读分析业务代码；允许在指定文档目录输出审计报告。
- 不重启服务、不接续现有业务 Ticket、不修改数据库或远端 Issues。
- 严格区分代码已实现、测试通过、真实运行通过和仅有设计文档。
- 不将 Skill 的 Prompt 内容当作运行能力已存在的证据。
- 所有架构问题提供具体代码路径及调用证据。
- 如果 GitNexus 不可用，使用源码与 TypeScript 工具分析，不重建或删除共享索引。
- 不要求每个 Feature 必须新建文件夹，优先考虑高内聚、低耦合、接口稳定和状态权威清晰。

完成后先提交报告供审查，不自动进入 S02–S05。

## 最后，我想强调一个方向

你现有平台最有价值的部分不是某个单独的 Skill，而是已经建立起来的 真实执行能力：多 Harness、Git Worktree、持久执行状态、隔离权限、独立验收和重启恢复。

这些应该保留。

接下来真正值得补强的是两种能力：

Architect Inspector：阻止架构被新的代码持续侵蚀。

Gardening：将已经发生的错误转化成仓库未来能够自动执行的约束。

而代码整理应服务于这两个目标，不是为了让目录看起来整齐而重构。

我建议下一阶段遵循一个简单顺序：先理解真实架构 → 建立可验证的边界 → 实施中检查越界 → 沉淀 Gardening → 逐步收敛模块。

这样你才能真正得到想要的 Matt + pstack 平台，而不是一个功能越来越多、但越来越难理解和维护的 Agent 系统。