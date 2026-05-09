# 88 Harness Adapter Framework 设计文档

## 日期

2026-05-09

## 背景

这个项目已经先后把多种不同风格的 harness 接进了同一条 Feishu / ACPX / Live Room 工作流里：

- `codex`
- `claude`
- `claude-haha`
- `gemini-cli`
- `deepseek`

从结果上看，这件事已经不是“零散接几个 CLI”了，而是实际上形成了一套可复用的 **harness integration framework**。

当前的问题不再是“能不能再接一个新 agent”，而是：

1. 如何把现有经验抽象成稳定框架
2. 如何让后续接入一个新 harness 时，不再重复踩完整条链路
3. 如何把平台逻辑和各家 CLI / runtime 的差异隔离开

本文先聚焦第 1 部分：

- 如何抽象“不同 harness framework 的接入”

暂不展开第 2 部分：

- 如何抽象“不同 IM app 的接入”

## 目标

建立一套统一的 harness 接入模型，使后续新增任意本地/远端 harness 时，都可以按同一套步骤落地，而不是继续在多个文件里散点加分支。

理想结果是：

- 新 harness 的接入点固定
- session / continuation 语义统一
- 事件流和 room 进度展示统一
- permission / capability 描述统一
- Live Room / ACPX / Feishu 不直接依赖具体 harness 的 CLI 细节

## 当前代码里已经存在的“事实标准”

虽然现在还没有正式命名为 adapter framework，但代码里已经形成了 6 个稳定层次。

### 1. 类型与平台协议层

关键文件：

- `src/lib/acpx/types.ts`

这层定义了平台如何理解一个 harness：

- `harnessType`
- `executionBackend`
- `participant`
- `streamCallbacks`
- `permissionConfig`
- `watchdogConfig`

这意味着平台内部已经默认：

- harness 不是 UI 概念，而是执行节点
- harness 最终都要被表达成一个 `AcpxParticipantRequest`
- 上层 orchestration 不应该直接感知具体 CLI 参数

### 2. 发现与 catalog 层

关键文件：

- `src/lib/platform-local-init.ts`
- `src/lib/real-agents/index.ts`
- `src/lib/acpx/catalog.ts`
- `src/lib/live-room.ts`

这层负责回答两个问题：

1. 这个 harness 在当前环境里是否存在
2. 它应该怎样作为“可选成员”暴露给 ACPX / Live Room / Feishu

现有共性：

- local harness 先做 availability/version 检查
- platform local agent 先注册成当前 host 上的 agent 记录
- catalog 再把这些 agent 规范化成统一 `agent id`
- room / `/ap add` 不直接操作本地二进制，而是消费 catalog

这其实已经是一个标准 discovery pipeline。

### 3. 单 harness 执行适配层

关键文件：

- `src/lib/real-agents/codex-agent.ts`
- `src/lib/real-agents/claude-agent.ts`
- `src/lib/real-agents/deepseek-agent.ts`
- `src/lib/real-agents/gemini-agent.ts`

这层是每个 harness 最具体、也最容易重复造轮子的地方。

它们当前都在做同一类事情：

- 检查可用性
- 获取版本
- 执行一次新任务
- 恢复历史 session / thread
- 解析 stdout / stderr / json stream
- 捕获 session id / thread id
- 做 timeout / process lifecycle 管理

这说明每个 harness 的真正差异，主要集中在：

- 命令行参数怎么拼
- 输出事件怎么 parse
- session 标识字段叫什么
- 哪些错误算 continuation stale

### 4. ACPX runner 编排层

关键文件：

- `src/lib/acpx/runner.ts`

这层负责把“一个参与者请求”变成“实际执行”。

runner 当前已经承担了：

- 根据 backend 分流
- 根据 harnessType 选具体 executor
- 注入 permission/watchdog
- 注册运行中进程
- 发布流式事件
- 持久化 session/thread metadata
- 写入 participant summary / filesModified

也就是说，runner 实际上已经在扮演 **adapter orchestrator** 的角色。

### 5. session / continuation 层

关键文件：

- `src/lib/acpx/session-tracking.ts`
- `src/lib/acpx/continuation-retry.ts`
- `src/lib/live-room-delivery.ts`

这层解决的不是“怎么跑命令”，而是：

- 上一次的上下文能不能继续
- continuation id 存在哪里
- 哪些错误意味着旧 session 已失效
- 失败后是否回退 fresh session

这里最重要的设计事实是：

- Codex、Claude、Gemini、DeepSeek 的 session 叫法不一样
- 但平台要处理的是同一类问题

所以这层已经天然适合抽象成统一 continuation model。

### 6. capability / permission 描述层

关键文件：

- `src/lib/acpx/capabilities.ts`
- `src/lib/acpx/permissions.ts`

这层回答的是：

- 这个 harness 支不支持 interrupt
- 支不支持 resume after interrupt
- 支不支持 live session control
- 平台的 permission profile 在这个 harness 上能真实应用到什么程度

这一步非常关键，因为它把“平台想做什么”和“具体 CLI 实际支持什么”分开了。

## 核心结论

后续要快速复用，至少应该抽出两块公共模块：

### 模块 A：Harness Adapter 接口层

用途：

- 统一描述不同 harness 的执行能力和接入面

每个具体 harness 只实现自己的 adapter，不再到处写 if/else。

### 模块 B：Harness Session / Continuation 层

用途：

- 统一处理不同 harness 的 thread/session 概念
- 统一 stale 判定、fallback 逻辑、metadata 存储

这两个模块是最值得优先抽象的。

如果只抽一个，应该先抽 A；  
如果要真正让接新 harness 变快，A 和 B 最终都需要。

## 为什么必须这样抽

### 1. 目前“接一个新 harness”的改动面过宽

以 `gemini-cli` 为例，实际需要改动的链路包括：

- real agent executor
- local status / version
- platform-local bootstrap
- catalog
- runner
- capabilities
- permissions
- session tracking
- continuation fallback
- live-room delivery stale pattern
- Feishu local status

这说明接入流程已经有标准化空间了。

### 2. 现在的差异点其实很有限

每个 harness 真正不同的地方只有几类：

- CLI / runtime 的启动方式
- 输出格式
- session resume 方式
- permission 语义
- 错误模式

平台其余大部分逻辑，其实都是共性的。

### 3. 当前系统已经开始出现“同一类 bug 在多个 harness 上重复”

典型例子：

- timeout 清理
- progress 流式消息节流
- continuation stale 判定
- `null` timeout /默认值回退
- child process 生命周期与 room 状态不同步

这类问题一旦不抽公共层，后面会在每个 harness 上各自复发。

## 建议的正式抽象

### 一、定义统一的 Harness Adapter

建议抽象接口如下：

```ts
export interface HarnessAdapter {
  type: string;
  displayName: string;

  checkAvailability(): Promise<{
    available: boolean;
    version?: string;
  }>;

  getCatalogIdentity?(args: {
    hostname?: string | null;
  }): Promise<{
    runtimeAgentId: string;
    label?: string;
  }>;

  execute(args: HarnessExecuteArgs): Promise<HarnessExecuteResult>;

  resume?(args: HarnessResumeArgs): Promise<HarnessExecuteResult>;

  getCapabilities(args: {
    executionBackend: string;
  }): HarnessCapability;

  getPermissionSupport(args: {
    executionBackend: string;
  }): AcpxPermissionSupportSummary;

  getContinuationDescriptor?(metadata: Record<string, unknown>): {
    sessionId: string | null;
    sessionKind: string | null;
  };

  isInvalidContinuationError?(message: string): boolean;
}
```

### 二、定义统一的执行结果结构

平台最需要的不是“CLI 原始输出”，而是统一结果：

```ts
export interface HarnessExecuteResult {
  success: boolean;
  output?: string;
  error?: string;
  executionTime: number;
  filesModified?: string[];
  sessionId?: string;
  sessionKind?: string;
  threadId?: string;
  liveStreaming?: boolean;
}
```

这样 runner 就不需要为每个 harness 单独推断字段。

### 三、定义统一的 session metadata model

建议平台只认这些公共字段：

- `lastSessionId`
- `lastSessionKind`
- `lastSessionThreadId`
- `sessionTracking.rootSessionId`
- `sessionTracking.latestSessionId`
- `sessionTracking.latestSessionKind`

每个 harness 仍然可以保留自己的兼容字段，例如：

- `codexThreadId`
- `claudeSessionId`
- `deepseekThreadId`
- `geminiSessionId`

但这些应视为 adapter 私有兼容层，而不是平台主字段。

### 四、定义统一的 CLI runtime helper

建议新增一个公共底座，例如：

- `src/lib/harness/runtime/cli-runner.ts`

统一处理：

- spawn
- timeout
- SIGTERM / SIGKILL 升级
- settled/closed 状态
- stdout/stderr 收尾
- onSpawn
- streamCallbacks

这样各家 harness 只实现：

- `buildCommand`
- `parseEventLine`
- `extractSessionId`

### 五、定义统一的 continuation fallback registry

建议不要把 invalid pattern 分散在：

- `live-room-delivery.ts`
- `continuation-retry.ts`
- 各 harness executor

而是改成 adapter 自己提供：

```ts
isInvalidContinuationError(message: string): boolean
```

平台层只做：

- 发现失败
- 问 adapter 这是不是 stale continuation
- 如果是，则 fresh retry

## 推荐的模块边界

### 平台公共层应该负责

- ACPX participant 模型
- room / task / event / permission / session 的平台协议
- runner orchestration
- continuation fallback 总流程
- live-room 进度消息与状态同步

### 具体 harness adapter 应该负责

- availability / version
- execute / resume
- parse output
- session id / thread id 抽取
- invalid continuation pattern
- capability / permission support 声明

### 不建议再由上层直接负责

- 某个具体 CLI 的命令行参数
- 某个具体 CLI 的 JSON line 字段名
- 某个具体 CLI 的 timeout 清理细节
- 某个具体 CLI 的 session 错误模式

## 新 harness 的标准接入流程

以后接任意新 harness，建议固定按下面 8 步执行。

### Step 1：先做能力评估

先确认这 4 件事：

1. 是否有非交互/headless 模式
2. 是否有结构化输出，最好是 JSON / stream-json
3. 是否支持 session / thread resume
4. permission / sandbox 语义是否可映射

如果连 1 和 2 都没有，不建议直接接。

### Step 2：实现 adapter

至少实现：

- `checkAvailability`
- `execute`
- `resume`（如果支持）
- `getCapabilities`
- `getPermissionSupport`

### Step 3：接入 discovery / catalog

包括：

- local status/version
- platform local bootstrap
- catalog id 规范化

### Step 4：接入 runner

包括：

- `platform_local` 或 `remote_ssh` 分支
- session metadata persistence
- streamCallbacks 联动

### Step 5：接入 continuation tracking

包括：

- session id 提取
- stale error pattern
- fresh retry fallback

### Step 6：接入 live-room 进度与失败展示

包括：

- stdout/stderr 转 progress
- tool event（如果有）
- timeout / interrupt / failed 的用户可见表现

### Step 7：接入 capability / permission 声明

不要等 UI 出 bug 才补这层。

### Step 8：做最小真实验证矩阵

至少测：

1. availability/version
2. fresh run
3. continuation run
4. timeout
5. failure after invalid session
6. room progress
7. interrupt / stop（如果支持）

## 现阶段最值得立刻做的重构

### Phase 1：先抽 Adapter Registry

目标：

- 不再在 `runner.ts` / `catalog.ts` / `session-tracking.ts` 里到处堆分支

最小落地：

- 新增 `harness-registry.ts`
- 每个 harness 导出 adapter
- 由 registry 提供：
  - lookup by `harnessType`
  - availability check
  - capabilities
  - permission support

### Phase 2：再抽 CLI Runtime 底座

目标：

- 消除各 harness 子进程生命周期逻辑的重复

### Phase 3：统一 continuation model

目标：

- 消除各 harness session 语义的散点实现

## 当前哪些文件最适合作为重构起点

建议第一批重点关注：

- `src/lib/real-agents/index.ts`
- `src/lib/acpx/runner.ts`
- `src/lib/acpx/session-tracking.ts`
- `src/lib/acpx/continuation-retry.ts`
- `src/lib/acpx/capabilities.ts`
- `src/lib/acpx/permissions.ts`
- `src/lib/acpx/catalog.ts`

原因是这些文件已经构成了事实上的“半成品框架”，最适合先收敛，而不是另起炉灶。

## 不应该做的事

### 1. 不要先抽一个过度理想化的大框架

应该沿当前已验证链路抽象，而不是完全重写。

### 2. 不要把 room / Feishu / task orchestration 和 harness adapter 混在一起

IM 接入和 harness 接入是两层问题。

### 3. 不要先统一 UI，再统一 adapter

真正决定复用速度的是 adapter 层，不是界面层。

## 最终结论

这套系统已经具备抽象出 **Harness Adapter Framework** 的条件。

后续要快速复用，最少应沉淀两块：

1. `Harness Adapter` 接口层
2. `Harness Session / Continuation` 公共层

如果继续按当前方式扩展，新 harness 仍然能接，但每接一个都会重复改 discovery、runner、session tracking、retry、capability、permission 等多个点，长期维护成本会越来越高。

如果按本文方案推进，未来接入一个新 harness 的目标应该收敛成：

- 写一个 adapter
- 注册到 registry
- 补一份能力声明
- 跑完 checklist

而不是再重复走一次全链路散点改造。

## 下一步建议

建议后续按这个顺序推进：

1. 先基于本文再产出一份 `HarnessAdapter` 最小接口草案
2. 再做 `registry + capability + permission` 第一阶段重构
3. 最后再抽 `CLI runtime helper` 和统一 continuation model

这样风险最低，也最符合当前代码的自然演进方向。
