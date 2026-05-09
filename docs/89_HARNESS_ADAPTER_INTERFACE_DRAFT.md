# 89 HarnessAdapter 最小接口草案

## 日期

2026-05-09

## 文档目标

这不是再讲一遍总体设计，而是把 `88_HARNESS_ADAPTER_FRAMEWORK_DESIGN.md` 压缩成一份 **可以直接进入实现阶段** 的接口草案。

它要回答 3 个问题：

1. 第一阶段最小要抽出哪些接口
2. 这些接口应该放在哪些文件
3. 现有 `codex / claude / claude-haha / gemini / deepseek` 应该如何迁移进去

## 范围约束

本草案只覆盖：

- harness adapter 抽象
- registry
- capability / permission / continuation 统一接线
- 第一期 runner 收敛点

本草案暂不覆盖：

- Feishu / IM adapter 抽象
- remote SSH 的通用 adapter 化
- 完整 CLI runtime helper 抽象
- 第二阶段 session store 重构

原因很简单：

- 如果第一步就试图把所有执行后端和所有 IM 一起统一，风险太高
- 当前最划算的切入点，是先把 **platform_local harness adapter** 抽出来

## 设计原则

### 1. 先包裹现有实现，不先重写现有实现

第一阶段不应该重写：

- `codex-agent.ts`
- `claude-agent.ts`
- `deepseek-agent.ts`
- `gemini-agent.ts`

而应该让 adapter 先“包住它们”。

这样做的好处：

- 风险低
- 回归面小
- 现有行为不容易被破坏

### 2. 先抽“平台视角接口”，不要先抽“CLI 视角接口”

平台真正关心的是：

- 能否执行
- 能否恢复
- 能力是什么
- session 怎么识别
- continuation 错误怎么判断

而不是：

- 某个 CLI 用什么 flag
- 某个 CLI 的某个 JSON 字段叫啥

这些 CLI 细节应该留在 adapter 内部。

### 3. 第一阶段先保证“可挂接”，第二阶段再追求“更优雅”

第一阶段只需要做到：

- 把新 harness 的改动面从“散点 if/else”收敛成“注册一个 adapter”

不要求第一阶段就做到：

- 完全零分支
- 所有 runtime helper 完全统一
- 所有 metadata 字段一次清理干净

## 第一阶段建议新增的文件

### A. `src/lib/harness/types.ts`

用途：

- 承载 adapter 体系自己的类型，不污染 ACPX 核心类型

建议内容：

```ts
import type {
  AcpxExecutionBackend,
  AcpxPermissionConfig,
  HarnessCapability,
  HarnessStreamCallbacks,
} from '@/lib/acpx/types';
import type { AcpxPermissionSupportSummary } from '@/lib/acpx/permissions';
import type { ChildProcess } from 'child_process';

export interface HarnessTask {
  id: string;
  name: string;
  description?: string;
}

export interface HarnessExecutionContext {
  workingDirectory: string;
  executionBackend: AcpxExecutionBackend;
  permissionConfig?: AcpxPermissionConfig;
  timeout: number | null;
  streamCallbacks?: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void;
  onSessionStarted?: (sessionId: string) => void;
}

export interface HarnessExecuteArgs {
  task: HarnessTask;
  context: HarnessExecutionContext;
}

export interface HarnessResumeArgs {
  task: HarnessTask;
  context: HarnessExecutionContext;
  sessionId: string;
  continuationMessage: string;
}

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

export interface HarnessAvailability {
  available: boolean;
  version?: string;
}

export interface HarnessContinuationDescriptor {
  sessionId: string | null;
  sessionKind: string | null;
}

export interface HarnessAdapter {
  type: string;
  displayName: string;

  checkAvailability(): Promise<HarnessAvailability>;
  execute(args: HarnessExecuteArgs): Promise<HarnessExecuteResult>;
  resume?(args: HarnessResumeArgs): Promise<HarnessExecuteResult>;

  getCapabilities(executionBackend: AcpxExecutionBackend): HarnessCapability;
  getPermissionSupport(executionBackend: AcpxExecutionBackend): AcpxPermissionSupportSummary;

  readContinuation?(metadata: Record<string, unknown>): HarnessContinuationDescriptor;
  isInvalidContinuationError?(message: string): boolean;
}
```

### B. `src/lib/harness/registry.ts`

用途：

- 统一注册各个 harness adapter
- 对 runner / catalog / session-tracking 提供统一 lookup

建议内容：

```ts
import type { HarnessAdapter } from './types';

const registry = new Map<string, HarnessAdapter>();

export const registerHarnessAdapter = (adapter: HarnessAdapter) => {
  registry.set(adapter.type, adapter);
};

export const getHarnessAdapter = (type: string) => registry.get(type);

export const listHarnessAdapters = () => Array.from(registry.values());
```

### C. `src/lib/harness/adapters/`

建议目录：

- `src/lib/harness/adapters/codex.ts`
- `src/lib/harness/adapters/claude.ts`
- `src/lib/harness/adapters/claude-haha.ts`
- `src/lib/harness/adapters/gemini.ts`
- `src/lib/harness/adapters/deepseek.ts`

注意：

- 这些 adapter 文件第一阶段只是薄包装
- 底层仍调用现有 `src/lib/real-agents/*.ts`

## 第一阶段不建议新建的文件

先不要急着建：

- `cli-runtime-helper.ts`
- `session-store.ts`
- `backend-adapter.ts`

这些都应该放在第二阶段以后。

## 第一阶段最小 adapter 形态

### 示例：Gemini adapter

```ts
import type { HarnessAdapter } from '../types';
import { executeGeminiTask, resumeGeminiSession, isGeminiAvailable, getGeminiVersion } from '@/lib/real-agents/gemini-agent';

export const geminiHarnessAdapter: HarnessAdapter = {
  type: 'gemini-cli',
  displayName: 'Gemini CLI',

  async checkAvailability() {
    const available = await isGeminiAvailable();
    return {
      available,
      version: available ? await getGeminiVersion() : undefined,
    };
  },

  async execute({ task, context }) {
    const result = await executeGeminiTask(task, {
      timeout: context.timeout,
      workingDirectory: context.workingDirectory,
      streamCallbacks: context.streamCallbacks,
      sandboxMode: context.permissionConfig?.sandboxMode,
      approvalPolicy: context.permissionConfig?.approvalPolicy,
      onSpawn: context.onSpawn,
      onSessionStarted: context.onSessionStarted,
    });

    return {
      success: result.success,
      output: result.output,
      error: result.error,
      executionTime: result.executionTime,
      filesModified: result.filesModified,
      sessionId: result.sessionId,
      sessionKind: result.sessionId ? 'gemini_session' : undefined,
      liveStreaming: true,
    };
  },

  async resume({ task, context, sessionId, continuationMessage }) {
    const result = await resumeGeminiSession({
      sessionId,
      prompt: continuationMessage,
      timeout: context.timeout,
      workingDirectory: context.workingDirectory,
      streamCallbacks: context.streamCallbacks,
      sandboxMode: context.permissionConfig?.sandboxMode,
      approvalPolicy: context.permissionConfig?.approvalPolicy,
      onSpawn: context.onSpawn,
      onSessionStarted: context.onSessionStarted,
    });

    return {
      success: result.success,
      output: result.output,
      error: result.error,
      executionTime: result.executionTime,
      filesModified: result.filesModified,
      sessionId: result.sessionId,
      sessionKind: result.sessionId ? 'gemini_session' : undefined,
      liveStreaming: true,
    };
  },

  getCapabilities(executionBackend) {
    return getHarnessCapabilities('gemini-cli', executionBackend);
  },

  getPermissionSupport(executionBackend) {
    return getLocalHarnessPermissionSupport('gemini-cli', executionBackend);
  },

  readContinuation(metadata) {
    const sessionId =
      typeof metadata.geminiSessionId === 'string' && metadata.geminiSessionId.trim()
        ? metadata.geminiSessionId.trim()
        : null;
    return {
      sessionId,
      sessionKind: sessionId ? 'gemini_session' : null,
    };
  },

  isInvalidContinuationError(message) {
    return [
      /Invalid session identifier/i,
      /Error resuming session/i,
      /Use --list-sessions/i,
    ].some((pattern) => pattern.test(message));
  },
};
```

这个例子说明一件事：

- 第一阶段 adapter 完全可以很薄
- 真正的意义不在“少几行代码”
- 而在“把平台调用面稳定下来”

## runner 在第一阶段怎么改

第一阶段 runner 不需要完全重写，只需要收敛 3 个点。

### 点 1：本地执行分支改为查 adapter

当前：

- `runner.ts` 里按 harnessType 手写分支：
  - codex
  - claude
  - deepseek
  - gemini

第一阶段建议：

- 保留 backend 分流
- 但 `platform_local` 分支不再直接 `if (participant.harnessType === ...)`
- 改成：
  - `const adapter = getHarnessAdapter(participant.harnessType)`
  - 没 adapter 就报错
  - 有 adapter 就走 `execute/resume`

### 点 2：session 持久化仍暂时留在 runner

第一阶段不要急着把 session metadata 持久化也抽走。

原因：

- 这一步牵涉数据库字段和兼容逻辑
- 一次动太多，回归风险高

所以第一阶段允许保留：

- `persistCodexThreadMetadata`
- `persistClaudeSessionMetadata`
- `persistDeepSeekThreadMetadata`
- `persistGeminiSessionMetadata`

但 runner 不应该再负责：

- continuation 错误模式判断
- capability / permission 的具体 harness 分支

### 点 3：permission/capability 查 adapter

当前：

- `capabilities.ts`
- `permissions.ts`

仍是静态 if/else。

第一阶段有两种做法：

#### 做法 A：完全兼容

- adapter 内部仍调用老函数
- 先不重写 `capabilities.ts` / `permissions.ts`

这是我建议的第一步。

#### 做法 B：马上下沉

- 把这两个文件的静态逻辑迁到 adapter

这个更彻底，但风险更高。

建议先 A 后 B。

## continuation 在第一阶段怎么改

### 建议目标

让“错误模式”从平台层移到 adapter 层。

### 当前问题

现在 continuation stale 逻辑散落在：

- `acpx/session-tracking.ts`
- `acpx/continuation-retry.ts`
- `live-room-delivery.ts`

平台对具体 harness 仍然知道太多。

### 第一阶段最小改法

先不动 session metadata 结构，只改“错误判定来源”：

- `continuation-retry.ts`
  - 改为 `adapter.isInvalidContinuationError(message)`
- `live-room-delivery.ts`
  - 同样改为查 adapter

这样就已经能把 stale pattern 从平台层剥离掉。

## catalog / discovery 在第一阶段怎么改

第一阶段不追求把整条 discovery pipeline 全 adapter 化，但建议至少统一 availability lookup。

### 当前状态

`real-agents/index.ts` 已经在做：

- `isAvailable`
- `getVersion`
- 聚合状态

### 第一阶段建议

增加一个 adapter registry 驱动的聚合入口，例如：

```ts
export const getLocalHarnessStatusMap = async () => {
  const adapters = listHarnessAdapters();
  const pairs = await Promise.all(
    adapters.map(async (adapter) => [adapter.type, await adapter.checkAvailability()] as const)
  );

  return Object.fromEntries(pairs);
};
```

这样以后 catalog 层不需要继续了解具体 harness 的 availability 细节。

## 第一阶段最小迁移顺序

建议严格按下面顺序来。

### Step 1

新增：

- `src/lib/harness/types.ts`
- `src/lib/harness/registry.ts`

### Step 2

新增 5 个 adapter 包装文件：

- codex
- claude
- claude-haha
- gemini
- deepseek

但底层仍复用现有 real-agents 实现。

### Step 3

把 `capabilities.ts` / `permissions.ts` 先“桥接”到 adapter，而不是直接删除。

### Step 4

把 `continuation-retry.ts` 和 `live-room-delivery.ts` 的 invalid pattern 判断改成查 adapter。

### Step 5

把 `runner.ts` 的 `platform_local` 执行分支改成 adapter 驱动。

### Step 6

最后才考虑收敛 `real-agents/index.ts` 的状态聚合。

## 第一阶段需要修改的文件清单

### 新增

- `src/lib/harness/types.ts`
- `src/lib/harness/registry.ts`
- `src/lib/harness/adapters/codex.ts`
- `src/lib/harness/adapters/claude.ts`
- `src/lib/harness/adapters/claude-haha.ts`
- `src/lib/harness/adapters/gemini.ts`
- `src/lib/harness/adapters/deepseek.ts`

### 修改

- `src/lib/acpx/runner.ts`
- `src/lib/acpx/continuation-retry.ts`
- `src/lib/live-room-delivery.ts`
- `src/lib/real-agents/index.ts`
- `src/lib/acpx/capabilities.ts`
- `src/lib/acpx/permissions.ts`

### 暂不修改或仅轻改

- `src/lib/platform-local-init.ts`
- `src/lib/acpx/session-tracking.ts`
- `src/lib/acpx/catalog.ts`
- `src/lib/feishu.ts`

原因：

- 这些文件虽然和 harness 有关，但不应该在第一阶段一起大动

## 新 session 里建议的开局方式

你准备开新 session 实现时，我建议一开始就把任务写得非常明确，不要只说“按 88 文档重构”。

建议你直接给新 session 这样的目标：

1. 先实现 `HarnessAdapter` 最小接口和 `registry`
2. 先只接 `platform_local`
3. 先包现有 `real-agents`，不要重写底层 executor
4. 先把 `runner + continuation error lookup` 切到 adapter
5. 不要在第一阶段动 remote SSH 和 IM 抽象

这样新 session 会更容易收敛，不会一上来就失控成大重构。

## 第一阶段完成的判定标准

只要达到下面几点，就可以认为第一阶段成功：

1. 新增一个 harness 时，不再需要去 `runner.ts` 里继续堆新的本地执行分支
2. continuation invalid pattern 不再散落在多个平台文件里
3. capability / permission 入口已经能由 adapter 提供
4. 现有 `codex / claude / gemini / deepseek` 行为不回归
5. live room 和 Feishu 现有主流程不需要改协议

## 最后的建议

新 session 的第一目标，不应该是“把所有东西抽象得最漂亮”，而应该是：

- 先把“新 harness 的接入点”稳定下来

只要做到这一点，后面你们再接新的 framework，复杂度就会明显下降。

如果第一阶段做得太激进，最容易炸的是：

- runner
- continuation
- timeout / progress / room side effects

所以第一阶段一定要“薄包装、少迁移、先收口”。
