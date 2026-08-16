---
doc_type: ISSUE
doc_status: draft
next_action: none
---

# ISSUE · Agent 运行时能力增强：多模型动态切换、思考长度/推理预算调节、Skill 技能体系集成与运行中随时插话干预

## 状态与优先级

- **优先级**：P1（直接决定多 Agent 协同能力上限、模型推理质量与日常开发调试交互体验，纳入核心开发支持计划）。
- **状态**：draft，记录于 Git Inbox，供后续跨 Harness 运行时架构重构、Live Room / Web 控制台能力升级排期使用。
- **提出时间**：2026-08-15。
- **关联议题**：
  - [377_ISSUE_20260804_Agent执行过程详细信息折叠显示方案.md](file:///data1/code/agent-platform-v2/docs/inbox/377_ISSUE_20260804_Agent%E6%89%A7%E8%A1%8C%E8%BF%87%E7%A8%8B%E8%AF%A6%E7%BB%86%E4%BF%A1%E6%81%AF%E6%8A%98%E5%8F%A0%E6%98%BE%E7%A4%BA%E6%96%B9%E6%A1%88.md)（过程可观测性与折叠交互）
  - [382_ISSUE_20260804_Agent职责分工与按意图路由.md](file:///data1/code/agent-platform-v2/docs/inbox/382_ISSUE_20260804_Agent%E8%81%8C%E8%B4%A3%E5%88%86%E5%B7%A5%E4%B8%8E%E6%8C%89%E6%84%8F%E5%9B%BE%E8%B7%AF%E7%94%B1.md)（Agent 职责维度与能力分工）
  - [391_ISSUE_20260809_双工作模式演进_GitWorktree并行工作树与角色分工串行流水线及平滑切换.md](file:///data1/code/agent-platform-v2/docs/inbox/391_ISSUE_20260809_%E5%8F%8C%E5%B7%A5%E4%BD%9C%E6%A8%A1%E5%BC%8F%E6%BC%94%E8%BF%9B_GitWorktree%E5%B9%B6%E8%A1%8C%E5%B7%A5%E4%BD%9C%E6%A0%91%E4%B8%8E%E8%A7%92%E8%89%B2%E5%88%86%E5%B7%A5%E4%B8%B2%E8%A1%8C%E6%B5%81%E6%B0%B4%E7%BA%BF%E5%8F%8A%E5%B9%B3%E6%BB%91%E5%88%87%E6%8D%A2.md)（多工作区与协同模式演进）

---

## 问题背景与现状缺口

当前 Agent Platform 在底层 Harness 接入、多 Agent 房间（Live Room）协作与任务调度上已建立基础框架，但在面向现代前沿大模型的高阶交互与灵活控制上，仍存在显著的能力短板：

### 1. 现状痛点一：无法动态切换底座模型（除 Codex 特化逻辑外）

- **现状分析**：
  - 数据库与业务逻辑中，目前仅在 `LiveRoomMember` 上硬编码了特化的 `codexModel` 字段，且在 API（如 `src/app/api/live-rooms/[id]/members/[memberId]/route.ts`）中显式限制 `if (codexSettings && member.harnessType !== 'codex') return 400`。
  - 对于其他核心 Harness（如 Kimi Code、Pi Agent、Claude / OpenClaw、Antigravity、DeepSeek 等），底座模型完全依赖环境变量默认值或固定脚本参数，用户在房间内或任务中无法灵活切换。
- **业务痛点**：
  - 用户无法针对不同难度的任务快速切换模型（例如：简单探索用快速模型，复杂架构与编码切换至旗舰模型；Claude 3.5 Sonnet / 3.7 Sonnet / Opus 之间切换；Gemini 2.5 Pro / Flash 之间切换；Kimi 不同代际切换等）。

### 2. 现状痛点二：无法灵活调节思考长度与推理预算（Thinking Budget / Reasoning Effort）

- **现状分析**：
  - 现代主力大模型（如 OpenAI o-series、Anthropic Claude Extended Thinking、Google Gemini Thinking Budget、Kimi Thinking 模式等）普遍支持显式控制推理思考深度与 Token 预算。
  - 当前平台除 Codex 存在受限的 `codexReasoningEffort` 外，系统缺乏通用的思考预算抽象与参数通道。
- **业务痛点**：
  - 用户无法根据场景在“低思考/快速响应（日常简单答疑、格式整理）”与“深度思考/超长推理（复杂架构重构、疑难 Bug 排查、形式化验证）”之间自由升降思考等级。

### 3. 现状痛点三：缺乏统一的 Skill 技能体系与动态加载机制

- **现状分析**：
  - 当前各 Agent/Harness 主要依赖自身内置的硬编码工具或单一预设 Prompt，平台未建立标准化的 Skill 体系。
  - 缺乏像 Codex Desktop、agent-skills 插件生态或 MCP 工具注册那样的动态技能加载与管理能力。
- **业务痛点**：
  - 无法在飞书房间或 Web 端为指定 Agent 按需挂载专业技能包（例如：`api-and-interface-design`、`code-review-and-quality`、`debugging-and-error-recovery`、自定义 MCP Server 或业务专有工具），限制了 Agent 向特定垂直工程领域延伸的能力。

### 4. 现状痛点四：运行中缺乏“随时插话/动态纠偏”能力（当前只能粗暴中断或被动排队）

- **现状分析**：
  - 当前系统在 Agent 运行中只提供两种极端处理方式：
    1. **被动排队 (`queue_message`)**：消息暂存，必须等待当前整轮长任务全部执行完毕后才被读取，无法及时纠正正在偏离方向的执行过程。
    2. **粗暴硬中断 (`interrupt_now` / `killProcessTree`)**：通过系统信号强行终止子进程，导致已生成的思考上下文与半成品状态瞬间丢弃或损坏。
  - 相比之下，在 Codex 桌面版等现代协同界面中，用户在 Agent 运行生成或执行工具调用的间歇，可以随时“插话”（输入引导提示或补充信息），客户端会平滑注入当前会话上下文并引导 Agent 纠偏。
- **业务痛点**：
  - 当用户发现 Agent 理解有误或需要即时补充关键上下文时，只能眼睁睁看着它跑偏，或者只能狠心打断全部重来，交互体验割裂且浪费算力。

---

## 核心架构与方案设计

针对上述四项能力缺口，设计**“统一运行时控制平面（Unified Agent Runtime Control Plane）”**升级方案：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    用户交互层 (Feishu Live Room / Web Console)               │
│  - 模型选择下拉 / 快捷命令 (/ap set-model)                                    │
│  - 思考预算滑块 (/ap set-thinking off|low|med|high|max)                      │
│  - Skill 技能挂载面板 (/ap skill enable|disable <skill>)                     │
│  - 运行中即时插话面板 (Mid-flight Steering & Live Intervention)              │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     平台控制平面 (Agent Platform Control Plane)              │
│ ┌──────────────────────┐ ┌──────────────────────┐ ┌───────────────────────┐ │
│ │  通用模型与推理抽象   │ │  Skill 注册与注入    │ │ 运行时会话与 Steering │ │
│ │  (Model & Thinking)  │ │  (Skill Registry)    │ │ (Mid-flight Injection)│ │
│ └──────────┬───────────┘ └──────────┬───────────┘ └───────────┬───────────┘ │
└────────────┼────────────────────────┼─────────────────────────┼─────────────┘
             │                        │                         │
             ▼                        ▼                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       跨 Harness 统一适配与执行层                            │
│ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌──────────────────┐ │
│ │ Codex Harness │ │ Kimi Harness  │ │ Claude/OpenClaw│ │ Antigravity/Pi  │ │
│ └───────────────┘ └───────────────┘ └───────────────┘ └──────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1. 通用模型配置与动态切换抽象（Generic Model Switcher）

- **数据模型改造**：
  - 将 `LiveRoomMember` 中的 `codexModel` 通用化为 `model`（或通过 `runtimeConfig: { model?: string }` 扩展），保留旧字段平滑迁移。
  - 在 `Agent` 与 `LiveRoomMember` 层面统一模型标识解析规范（如 `vendor:model-id` 或标准模型名别名映射表）。
- **多层级配置覆盖（Cascade Configuration）**：
  - **L1 全局默认**：Harness / 环境变量提供的默认模型。
  - **L2 成员默认**：Live Room 成员或 Task 的持久化配置。
  - **L3 指令/会话级覆盖**：通过 `/ap config --model=...` 或 Web 界面即时调整，支持单次交互临时指定模型。
- **全 Harness 适配支持**：
  - 各 Harness 适配器统一从 `context.model` 提取模型并传递给底座命令行/API。

### 2. 思考长度与推理预算调节体系（Thinking Budget & Reasoning Control）

- **统一思考分级标准**：
  - 抽象平台级推理等级枚举：
    - `off`：禁用扩展思考（快速响应模式）。
    - `low`：轻量思考（例如 ~1,024 - 4,096 tokens 或 low effort）。
    - `medium`：平衡思考（例如 ~8,192 - 16,384 tokens 或 medium effort，默认推荐）。
    - `high`：深度思考（例如 ~32,768 - 64,000 tokens 或 high effort）。
    - `custom:<tokens>`：自定义精确 Token 预算。
- **底座供应商协议映射**：
  - OpenAI / Codex：映射为 `reasoning_effort` (`low` / `medium` / `high`)。
  - Anthropic Claude：映射为 `thinking: { type: "enabled", budget_tokens: N }`。
  - Google Gemini / Antigravity：映射为 `thinkingConfig: { thinkingBudget: N }`。
  - Kimi Code：映射为 Kimi 思考流开关与 token 限制。
- **交互入口**：
  - 飞书命令 `/ap thinking --agent=<name> --level=<off|low|medium|high>`。
  - Web UI 成员详情与聊天输入框旁的思考预算快速调节器。

### 3. Skill 技能体系与动态装配机制（Skill Registry & Dynamic Injection）

- **技能包标准规范（Skill Standard Specification）**：
  - 统一技能结构：包含 Frontmatter 元数据（名称、描述、触发条件、依赖工具）+ 指令 Prompt + Tool Schema 定义。
  - 兼容现有的标准 Agent Skills（如 `/plugins/agent-skills/skills/*` 与 Antigravity Skills）。
- **动态装配与生命周期管理**：
  - **Skill Registry**：平台统一注册中心，管理可用技能列表与能力标签。
  - **房间/成员级绑定**：支持在 Live Room 中为成员配置启用技能集（如 `skills: ["api-and-interface-design", "debugging-and-error-recovery"]`）。
  - **上下文动态注入**：在生成 Prompt 时，按需将激活 Skill 的关键规范与指导原则编译注入系统上下文；对支持外部工具调用的 Harness 动态挂载对应 Tool Handlers。

### 4. 运行中随时插话与动态干预机制（Mid-flight Steering & Live Intervention）

- **双轨干预通道设计**：
  - **Hard Stop（硬终止）**：保留用于紧急死循环或进程异常退出的 `stop_run` / `interrupt_now`。
  - **Soft Steer / Inject（软插话 / 动态纠偏）**：在 Agent 持续运行期间接收用户消息，无损注入正在进行的会话流。
- **动态注入实现策略**：
  1. **长连接 / 交互式会话 Harness（如 ACPX WebSocket / Stdin-driven Harness）**：
     - 将用户插话包装为 `steering_message` 帧即时推入 Harness 标准输入或控制通道。
     - Harness 在当前 Step 执行完毕后、下一步推理开始前合并该消息，实现实时调优。
  2. **批处理 / Step-by-Step Harness**：
     - 在平台 Step 调度器（Runner Event Loop）的步骤间隙检测 Pending Steering Messages。
     - 若存在插话，将其注入后续上下文并通知前端“已成功介入引导”。
- **飞书 / Web 交互体验升级**：
  - 用户在 Agent 执行中发言时，不再简单报错或直接强制杀死，而是提示：
    > 💡 Agent 正在运行中，已将您的补充指令作为**实时插话（Steering）**即时并入当前执行上下文。

---

## 分阶段实施规划

| 阶段 | 核心任务 | 交付物 | 预期收益 |
|---|---|---|---|
| **Phase 1：通用模型与思考长度抽象** | 1. 改造 `LiveRoomMember` 字段，建立通用 `model` 与 `thinkingBudget` 配置。<br>2. 升级飞书 `/ap config` 命令与 Web 成员配置面板。<br>3. 适配 Codex, Kimi, Pi, Claude, Antigravity 各 Harness 的模型与思考参数注入。 | 统一配置 API + Web / 飞书配置入口 + 跨 Harness 参数适配层 | 用户可随时为任意 Agent 切换模型与思考深度 |
| **Phase 2：运行中插话与 Steering 通道** | 1. 扩展 `TaskRunControlMessage` 支持 `steer_message` / `inject_prompt`。<br>2. 实现长连接与 Step 间隙的实时消息并入逻辑。<br>3. Web 端与飞书 Live Room 增加运行中插话交互与状态反馈。 | 实时插话控制协议 + 运行态消息即时注入机制 | 彻底告别“只能粗暴打断”，支持丝滑运行时纠偏 |
| **Phase 3：Skill 技能体系集成与管理** | 1. 建立平台 Skill Registry 与标准元数据规范。<br>2. 实现房间/成员级 Skill 动态挂载配置与 Prompt/Tool 编译注入。<br>3. 提供常用 Agent Skills 模板库与管理界面。 | Skill 注册中心 + 动态注入引擎 + 技能管理面板 | Agent 可按需加载专业技能，大幅拓宽能力边界 |

---

## 验收目标

1. **多模型切换**：用户可在 Web 界面或飞书群聊中，为房间内的任意 Agent（包括 Codex、Kimi、Pi、Claude、Antigravity 等）自由指定和切换底座模型。
2. **思考长度调节**：支持将 Agent 思考深度设置为 `off` / `low` / `medium` / `high` 或自定义预算，并在各模型实际调用中准确生效。
3. **Skill 动态挂载**：可在房间配置中为 Agent 动态启用/禁用指定 Skill，并在 Agent 思考与执行过程中切实发挥技能规范约束效力。
4. **运行中随时插话**：在 Agent 运行生成或多步执行过程中，用户发送补充提示可平滑注入上下文进行方向纠偏，无需强行中断进程。
5. **向后兼容性**：现有 Codex 专有配置平滑迁移，历史工作流与测试用例 100% 保持兼容。
