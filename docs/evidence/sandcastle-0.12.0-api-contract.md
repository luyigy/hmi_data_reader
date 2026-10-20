# `@ai-hero/sandcastle@0.12.0` 实际 API 契约复核

## 1. 复核对象与来源约定

- 复核对象是 npm 发布包，不是 GitHub `main` 或二手文章。`npm view @ai-hero/sandcastle@0.12.0 ...` 返回：tarball `https://registry.npmmirror.com/@ai-hero/sandcastle/-/sandcastle-0.12.0.tgz`、`gitHead` `e99f832f26dc9d245c019a9ddd19fa5dee792427`。
- 完整性：npm `dist.shasum` 为 `2163dd3151e9091bc4f8fdc737a1e38876c86e54`，`dist.integrity` 为 `sha512-kdQ414rM8t1QiWeqZ3Klz4KSd0PqQG4bRVuqGpRDUomWhojSZkEAc1tbcEcThVmBEaHkCt8LmYR49vqEPNIoYQ==`。对实际下载的 2,578,888 字节 tarball 独立计算 SHA-1/SHA-512，二者均一致；`npm pack` 报告 62 个文件。
- 官方 [`v0.12.0`](https://github.com/mattpocock/sandcastle/tree/v0.12.0) annotated tag 解引用到同一个 [`e99f832`](https://github.com/mattpocock/sandcastle/commit/e99f832f26dc9d245c019a9ddd19fa5dee792427)。发布包内 47 个一方源码 source-map 条目的 `sourcesContent` 与该 checkout 逐字一致；发布包与 tag 的 `README.md`、`package.json` SHA-256 也分别一致。
- 下文 `pkg:` 指 npm tarball 解包根目录，行号以该发布文件为准；`src:` 链接均固定在官方 `v0.12.0` tag。另做了发布 `dist` 的真实 ESM import，确认运行时导出，而非只读 README。

## 2. 包导出、核心函数和生命周期

### 2.1 导出形态

`run`、`createSandbox`、`createWorktree` 都是根模块的**命名运行时导出**；因此 `import { run } ...` 或 `import * as sandcastle ...; sandcastle.run(...)` 可用。包没有 default export，`import sandcastle from ...` 不是其声明的用法。

内置沙箱 provider 工厂（`docker()` 等）不从根模块导出，而从五个公开子路径导入：`docker`、`podman`、`vercel`、`daytona`、`no-sandbox`。`package.json` 没有暴露其他内部模块路径。

证据：`pkg:package.json:5-33`；`pkg:dist/index.d.ts:1051`；[`src/index.ts`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/index.ts)；发布包实际 import 的根导出与各沙箱子路径导出。

### 2.2 真实签名

```ts
run<A extends AgentProvider>(options: RunOptions<A>): Promise<RunResult>;
// 另有 output: Output.object(...) / Output.string(...) 的两个重载，
// 分别在结果上增加 typed output / string output。

createSandbox(options: {
  branch: string;             // 必填，显式分支
  baseBranch?: string;        // 仅在 branch 不存在时作为起点，默认 HEAD
  sandbox: SandboxProvider;   // 必填
  cwd?: string;
  hooks?: SandboxHooks;
  copyToWorktree?: string[];
  timeouts?: Timeouts;
}): Promise<Sandbox>;

createWorktree(options: {
  branchStrategy:
    | { type: "branch"; branch: string; baseBranch?: string }
    | { type: "merge-to-head" }; // 必填；不接受 head
  cwd?: string;
  copyToWorktree?: string[];
  hooks?: SandboxHooks;
  timeouts?: Timeouts;
}): Promise<Worktree>;
```

`RunOptions` 的必填字段是 `agent` 和 `sandbox`；支持 `cwd`、`prompt`/`promptFile`、`maxIterations`、`hooks`、`promptArgs`、`logging`、`completionSignal`、超时、`branchStrategy`、`resumeSession`、`signal`、结构化 `output` 等。`RunResult` 包含 `iterations`、`stdout`、`commits`、`branch`、可选 `completionSignal`、`logFilePath`、`preservedWorktreePath`、`resume`、`fork`。

证据：`pkg:dist/index.d.ts:502-638`（`run`）；`pkg:dist/index.d.ts:709-734,878-883`（`createSandbox`）；`pkg:dist/index.d.ts:885-907,1019-1026`（`createWorktree`）；[`src/run.ts:332-487`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/run.ts#L332-L487)，[`src/createSandbox.ts:63-98`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/createSandbox.ts#L63-L98)，[`src/createWorktree.ts:61-86`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/createWorktree.ts#L61-L86)。

### 2.3 `Sandbox` / `Worktree` 句柄

```ts
interface Sandbox {
  readonly branch: string;
  readonly worktreePath: string;
  run(options: SandboxRunOptions): Promise<SandboxRunResult>;
  interactive(options: SandboxInteractiveOptions): Promise<SandboxInteractiveResult>;
  exec(command: string, options?: {
    onLine?: (line: string) => void;
    cwd?: string;
    sudo?: boolean;
    stdin?: string;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  close(): Promise<{ preservedWorktreePath?: string }>;
  [Symbol.asyncDispose](): Promise<void>;
}
```

没有名为 `dispose()` 的公开方法；自动清理是 `await using` 触发的 `[Symbol.asyncDispose]`。`Worktree` 同样暴露 `branch`、`worktreePath`、`run`、`interactive`、`createSandbox`、`close`、`[Symbol.asyncDispose]`。

证据：`pkg:dist/index.d.ts:781-877`；`pkg:dist/index.d.ts:977-1017`；[`src/createSandbox.ts:224-263`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/createSandbox.ts#L224-L263)，[`src/createWorktree.ts:191-206`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/createWorktree.ts#L191-L206)。

## 3. `AgentProvider` 与内置 agent

### 3.1 自定义 provider 必须实现的契约

```ts
interface AgentProvider {
  readonly name: string;
  readonly env: Record<string, string>;
  readonly captureSessions: boolean;
  readonly sessionStorage?: AgentSessionStorage;
  buildPrintCommand(options: AgentCommandOptions): {
    command: string;
    stdin?: string;
  };
  buildInteractiveArgs?(options: AgentCommandOptions): string[];
  parseStreamLine(line: string): ParsedStreamEvent[];
  parseSessionUsage?(content: string): IterationUsage | undefined;
}
```

`env` 和 `captureSessions` 在接口上是必填字段；可选的 `buildInteractiveArgs` 若要调用 `interactive()` 就必须提供。`AgentCommandOptions` 传入 `prompt`、`dangerouslySkipPermissions`，以及可选 `resumeSession`、`forkSession`。`buildPrintCommand` 返回 shell command 字符串和可选 stdin，不是 argv 数组。

`parseStreamLine` 的内部事件并集为：

- `{ type: "text"; text }`
- `{ type: "result"; result }`
- `{ type: "tool_call"; name; args }`
- `{ type: "session_id"; sessionId }`
- `{ type: "usage"; usage }`

若要支持宿主 session 捕获/恢复，还需提供 `sessionStorage`，其方法为 `captureToHost`、`resumeIntoSandbox`、`readHostSession`、`existsOnHost`、`hostSessionFilePath`、`findByIdOnHost`。仅有 `sessionId` 并不等于已具备跨沙箱恢复能力。

证据：`pkg:dist/index.d.ts:60-148`；[`src/AgentProvider.ts:34-39,202-277`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/AgentProvider.ts#L34-L277)。

### 3.2 内置列表与缺席项

| 工厂 | 实际 `name` | 默认 session 捕获 | `sessionStorage` |
|---|---|---:|---:|
| `claudeCode(model, options?)` | `claude-code` | 开 | 有 |
| `codex(model, options?)` | `codex` | 开 | 有 |
| `pi(model, options?)` | `pi` | 开 | 有 |
| `cursor(model, options?)` | `cursor` | 关 | 无 |
| `opencode(model, options?)` | `opencode` | 关 | 无 |
| `copilot(model, options?)` | `copilot` | 关 | 无 |

因此：**内置 Codex、Claude Code（工厂名是 `claudeCode`，不是 `claude`）、Pi、Cursor；另有 OpenCode 和 Copilot。没有专用 Antigravity/`agy`、Kimi Code/`kimiCode` provider。** 实际 ESM import 中 `agy`、`antigravity`、`kimiCode` 均为 `undefined`；官方 tag 全仓检索也无这些 provider。接入 Antigravity 或 Kimi Code 时需要自定义 `AgentProvider`，不能写成内置导入。

证据：`pkg:dist/index.d.ts:149-241,1051`；[`src/AgentProvider.ts:613-1267`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/AgentProvider.ts#L613-L1267)；[`src/InitService.ts:409-478`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/InitService.ts#L409-L478)。

注意区分 agent 与 sandbox：自定义 sandbox 应使用 `createBindMountSandboxProvider(config)` 或 `createIsolatedSandboxProvider(config)`；bind-mount handle 需要 `worktreePath`、实时逐行 `exec`、`copyFileIn`、`copyFileOut`、`close`，isolated handle 则使用 `copyIn`/`copyFileOut`，两者都可选 `interactiveExec`。证据：`pkg:dist/SandboxProvider-EkSMuBp8.d.ts:20-57,58-139,223-241`。

## 4. 认证、环境变量、代理、挂载和镜像

### 4.1 环境变量与认证

- agent 工厂和 sandbox 工厂都有 `env?: Record<string, string>`。合并以 `.sandcastle/.env` 解析结果为基底，再依次应用 sandbox env 和 agent env，后者优先级更高；agent 与 sandbox env 若有同名 key 会直接抛错，而不是让一方静默覆盖另一方。
- `.sandcastle/.env` 优先于 `process.env`；**只有已在 `.sandcastle/.env` 声明的 key 才会从 `process.env` 回退读取**。仓库根 `.env` 不在解析链中，不能假设任意宿主环境变量会自动进入容器。
- 顶层 `run()` 的 `RunOptions` 和 `sandbox.run()` 的 `SandboxRunOptions` 均没有直接 `env` 字段；这里应使用 provider 工厂 env 或 `.sandcastle/.env`。`interactive()` 与 `WorktreeRunOptions` 另有各自的 `env` 字段，不能反推到所有 API。

证据：`pkg:dist/index.d.ts:135-148,502-588,769-780`；`pkg:dist/sandboxes/docker.d.ts:39-46`；[`src/EnvResolver.ts:49-73`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/EnvResolver.ts#L49-L73)，[`src/mergeProviderEnv.ts:1-31`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/mergeProviderEnv.ts#L1-L31)。

`AgentProvider` 没有独立的 `authenticate()` 方法；认证通过 agent CLI、env 和镜像配置完成。v0.12.0 的 `init` 模板给出的 agent env 是：Claude Code `CLAUDE_CODE_OAUTH_TOKEN` 或注释掉的 `ANTHROPIC_API_KEY`；Pi `ANTHROPIC_API_KEY`；Codex **`OPENAI_KEY`**；Cursor `CURSOR_API_KEY`；OpenCode `OPENCODE_API_KEY`；Copilot `GITHUB_TOKEN`（注释说明 `COPILOT_GITHUB_TOKEN` 优先于 `GH_TOKEN`/`GITHUB_TOKEN`）。这是官方脚手架的默认模板，不应扩大解释为各 CLI 的全部认证方式。

证据：发布包 `pkg:dist/main.js:18355-18423`；[`src/InitService.ts:409-478`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/InitService.ts#L409-L478)。

沙箱服务自身认证：Vercel 有 `token?`，回退到 SDK 的 `VERCEL_OIDC_TOKEN`/`VERCEL_TOKEN`；Daytona 有 `apiKey?`、`apiUrl?`、`target?`，分别回退到 `DAYTONA_API_KEY`、`DAYTONA_API_URL`、`DAYTONA_TARGET`。证据：`pkg:dist/sandboxes/vercel.d.ts:17-43`；`pkg:dist/sandboxes/daytona.d.ts:11-34`；[`src/sandboxes/daytona.ts:80-95`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/sandboxes/daytona.ts#L80-L95)。

### 4.2 代理与网络

发布包公开声明和一方 `src/` 中没有专用 `proxy`/`proxyUrl` 配置。可确认的通用通道是把 `HTTP_PROXY` 等作为 provider `env` 注入；agent CLI 是否采用这些变量属于各 CLI 的契约，Sandcastle 不另作保证。Docker/Podman 另有 `network?: string | readonly string[]`，Vercel 另有 `networkPolicy?: Record<string, unknown>`，它们不是 HTTP 代理配置。

证据：`pkg:dist/sandboxes/docker.d.ts:45-55`；`pkg:dist/sandboxes/podman.d.ts:55-65`；`pkg:dist/sandboxes/vercel.d.ts:60-64,82-83`；[`src/DockerLifecycle.ts:126-169`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/DockerLifecycle.ts#L126-L169)。

### 4.3 文件/目录挂载

Docker/Podman 使用：

```ts
mounts?: readonly {
  hostPath: string;
  sandboxPath: string;
  readonly?: boolean; // 默认 false
}[];
```

`hostPath` 必须存在；绝对路径直接使用，`~` 展开，**相对路径按 `process.cwd()` 解析，不是按 `RunOptions.cwd`**。`sandboxPath` 的 `~` 按 `/home/agent` 展开，相对路径按沙箱 repo `/home/agent/workspace` 解析。实现除目录挂载外也专门处理文件挂载；文件目标的沙箱父目录必须是 `/home/agent` 或其子目录，否则配置阶段抛错。只读挂载最终形成 `:ro`，SELinux label 可设为 `"z"`、`"Z"` 或 `false`。

证据：`pkg:dist/MountConfig-CmXclHA5.d.ts:1-24`；`pkg:dist/sandboxes/docker.d.ts:31-44`；`pkg:dist/sandboxes/podman.d.ts:17-54`；[`src/mountUtils.ts:60-119`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/mountUtils.ts#L60-L119)，[`src/mountUtils.ts:328-398`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/mountUtils.ts#L328-L398)。

### 4.4 镜像相关 API

- Docker/Podman 的选项名是 **`imageName`**，不是 `image`；缺省为 `sandcastle:<repo-dir-name>`。`defaultImageName` 也从这两个子路径导出。
- Docker 支持 `containerUid`、`containerGid`、`selinuxLabel`、`mounts`、`env`、`network`、`groups`、`devices`、`maxOutputTailChars`、`cpus`；Podman 另有 `userns`。
- 启动前会 inspect 本地镜像；缺失时直接报"先 build"，`run()`/`createSandbox()` 不会自动替调用方构建镜像。CLI 提供 `sandcastle docker build-image` 和 `sandcastle podman build-image`，分别使用 `.sandcastle/Dockerfile` 或 `Containerfile`。
- Vercel 使用 `source`、`runtime`/`template` 等 SDK 选项；Daytona 使用 `create?: CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams`，不是 Docker 的 `imageName` 契约。

证据：`pkg:dist/sandboxes/docker.d.ts:14-108`；`pkg:dist/sandboxes/podman.d.ts:14-122`；`pkg:dist/sandboxes/vercel.d.ts:26-102`；`pkg:dist/sandboxes/daytona.d.ts:25-58`；`pkg:README.md:768-830`；[`src/sandboxes/docker.ts:169-183`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/sandboxes/docker.ts#L169-L183)，[`src/sandboxes/docker.ts:398-431`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/sandboxes/docker.ts#L398-L431)，[`src/sandboxes/podman.ts:183-195`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/sandboxes/podman.ts#L183-L195)，[`src/sandboxes/podman.ts:462-472`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/sandboxes/podman.ts#L462-L472)。

## 5. `cwd`、已有 worktree 与 branch strategy

### 5.1 三种策略的真实语义

| 策略 | worktree / 分支行为 | 是否合并回宿主当前分支 | 适用范围 |
|---|---|---|---|
| `{ type: "head" }` | 直接使用 `cwd` 解析出的宿主工作目录及其当前分支，不创建 worktree | 否 | bind-mount 与 no-sandbox；是非 isolated provider 默认 |
| `{ type: "merge-to-head" }` | 创建 `.sandcastle/worktrees/` 下的临时分支/worktree | 是；成功后执行实际 `git merge <temp>`，随后删除临时分支 | 全部；isolated 默认 |
| `{ type: "branch", branch, baseBranch? }` | 在 managed worktree 中使用指定分支；`baseBranch` 只用于新建分支 | 不合并到宿主当前分支，提交留在指定分支 | 全部 |

`head` 与 `copyToWorktree` 不兼容；对 Vercel/Daytona 等 isolated provider 指定 `head` 会在运行时抛 `head branch strategy is not supported with isolated providers`。named branch 的已有 Sandcastle-managed worktree 可被复用，并可能从 `origin` fetch/fast-forward；主工作树或外部 worktree 已 checkout 同一分支则会报冲突。

证据：`pkg:dist/SandboxProvider-EkSMuBp8.d.ts:195-222`；`pkg:dist/index.d.ts:552-556`；[`src/run.ts:507-757`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/run.ts#L507-L757)，[`src/SandboxLifecycle.ts:404-483`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/SandboxLifecycle.ts#L404-L483)，[`src/WorktreeManager.ts:277-416`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/WorktreeManager.ts#L277-L416)。

### 5.2 能否直接复用宿主已有 worktree？

**能用一次性 `run()`（以及支持相同策略的 `interactive()`）做到，但不能用顶层 `createSandbox()` 表达。** 对 bind-mount 或 no-sandbox：

```ts
await run({
  cwd: "/path/to/existing-worktree",
  agent,
  sandbox: docker(),
  branchStrategy: { type: "head" },
  prompt: "...",
});
```

此路径直接把 `hostRepoDir` 传给 sandbox，不进入 `WorktreeManager.create()`，也不进入 merge-to-head 分支，所以不会创建嵌套 `.sandcastle/worktrees`，也不会合并到另一个宿主分支。`cwd` 同时仍是 `.sandcastle/.env`、默认日志等资源的锚点；因此"不创建 worktree"不等于"完全不写 `.sandcastle`"。

证据：[`src/SandboxFactory.ts:525-568`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/SandboxFactory.ts#L525-L568)；no-sandbox 的等价路径见 [`src/SandboxFactory.ts:342-374`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/SandboxFactory.ts#L342-L374)；`cwd` 契约见 `pkg:dist/index.d.ts:507-516`。

相比之下：

- `createSandbox({ cwd, branch, sandbox })` 的**参数形状本身有效**，但实现无条件调用 `WorktreeManager.create(hostRepoDir, { branch, baseBranch })`；它没有 `branchStrategy` 选项，不是 head API。它会在 `cwd/.sandcastle/worktrees/` 创建或复用 managed worktree。提交留在显式 `branch`，不会因此合并回宿主当前分支。
- 若把已有外部 worktree 的路径作为 `cwd`，又把其已 checkout 的当前分支传给 `branch`，冲突检测会拒绝，而不是"采纳"这个外部 worktree。
- `createWorktree()` 也只创建 managed worktree；`head` 在其类型中被明确排除。公开 API 没有 `adoptWorktree(path)` 或 `createSandboxFromExistingWorktree(path)`。

证据：`pkg:dist/index.d.ts:709-734,878-906`；[`src/createSandbox.ts:899-926`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/createSandbox.ts#L899-L926)；[`src/WorktreeManager.ts:303-361`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/WorktreeManager.ts#L303-L361)；[`src/createWorktree.ts:208-242`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/createWorktree.ts#L208-L242)。

## 6. 流式事件、中断、恢复和同沙箱测试命令

### 6.1 `onAgentStreamEvent` 确实存在，但位置与载荷有严格限定

正确位置是 `logging: { type: "file", path, onAgentStreamEvent }`，不是顶层 run option，也不是 `logging.type === "stdout"` 的字段。回调返回 `void`，异常会被吞掉；`verbose` 控制 raw 行是否额外写日志/stdout，不是回调的名称。

```ts
type AgentStreamEvent =
  | { type: "text"; message: string; iteration: number; timestamp: Date }
  | { type: "toolCall"; name: string; formattedArgs: string; iteration: number; timestamp: Date }
  | { type: "raw"; line: string; iteration: number; timestamp: Date };
```

`raw` 是 agent 的原始 **stdout** 行。注意公开事件是 `toolCall`/`formattedArgs`，与自定义 provider 内部解析事件的 `tool_call`/`args` 不是同一个结构。

证据：`pkg:dist/index.d.ts:243-272,451-490`；[`src/AgentStreamEmitter.ts:3-69`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/AgentStreamEmitter.ts#L3-L69)；[`src/run.ts:217-291`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/run.ts#L217-L291)；[`src/Orchestrator.ts:147-173`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/Orchestrator.ts#L147-L173)。

### 6.2 中断与恢复

- `run()`、`sandbox.run()`、`sandbox.interactive()` 和 Worktree 的运行接口接受 `signal?: AbortSignal`。预先 abort 会立即拒绝；迭代中 abort 会终止在途 agent subprocess，并以 `signal.reason` 拒绝。`Sandbox` 句柄在 abort 后仍可再次 `.run()` 或 `.close()`。
- `createSandbox()` 的创建选项没有 `signal`；`SandboxExecOptions` 也没有 `signal`/`timeout`，不能把 agent run 的中断契约套到任意 `exec()`。
- 恢复是 **agent session 恢复**，不是暂停进程后原地唤醒：`resumeSession` 要求宿主已有 session 文件，且不能与 `maxIterations > 1` 同用。`RunResult`/`SandboxRunResult` 另有可选 `.resume(prompt, options?)`；后者复用同一个长寿命沙箱。
- Claude Code、Codex、Pi 有实际 session storage/resume 命令。`.fork()` 则只对 Claude Code 和 Codex 有真实 fork 命令实现；Pi 的 `buildPrintCommand` 不读取 `forkSession`，不应将 Pi 当成支持独立 fork。

证据：`pkg:dist/index.d.ts:557-570,608-623,745-807,867-877`；`pkg:README.md:885-954`；[`src/createSandbox.ts:512-547`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/createSandbox.ts#L512-L547)；[`src/AgentProvider.ts:637-665`（Pi）](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/AgentProvider.ts#L637-L665)，[`src/AgentProvider.ts:782-825`（Codex）](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/AgentProvider.ts#L782-L825)，[`src/AgentProvider.ts:1190-1215`（Claude Code）](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/AgentProvider.ts#L1190-L1215)。

### 6.3 同一个暖沙箱执行测试

`createSandbox()` 后可交替调用 `sandbox.run()` 和 `sandbox.exec()`；容器、依赖和构建产物在调用之间保留。测试命令示例：

```ts
const result = await sandbox.exec("npm test", {
  cwd: "/optional/override",
  onLine: line => console.log(line),
});
// 返回 { stdout, stderr, exitCode }；非零 exitCode 不自动 throw。
```

默认 `cwd` 是沙箱 repo 路径。没有 `sandbox.test()` 之类的专用 API，也没有 `run()` 返回的独立 `Sandbox` 句柄；需要这种能力应显式使用 `createSandbox()` 的生命周期。

证据：`pkg:dist/index.d.ts:841-877`；`pkg:README.md:261-345`；[`src/createSandbox.ts:685-704`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/createSandbox.ts#L685-L704)。

## 7. 容易误判的调用方式汇总

| 看似合理的写法/假设 | 0.12.0 的实际情况 |
|---|---|
| `import sandcastle from "..."; sandcastle.run(...)` | 无 default export；用命名导入或 namespace import。`pkg:dist/index.d.ts:1051` |
| `createSandbox({ cwd, branch, sandbox })` 一定错误，因为缺 `branchStrategy` | 该说法不成立：此调用形状有效，`branch` 才是该 API 的显式分支参数；但它总走 managed worktree，不是 head。`pkg:dist/index.d.ts:709-734` |
| 用上述 `createSandbox` 直接复用已有 worktree，不创建嵌套 worktree | 不成立；它固定调用 `WorktreeManager.create()`。应改用 `run({ ..., branchStrategy: { type: "head" } })`，或另行设计封装。[实现](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/createSandbox.ts#L899-L926) |
| `createSandbox({ branchStrategy: { type: "head" }, ... })` | `CreateSandboxOptions` 没有该字段；即使 JS 传入额外属性也不会改变其显式分支 worktree 流程。 |
| `createWorktree({ branchStrategy: { type: "head" } })` | 明确不支持；只允许 `branch`/`merge-to-head`。`pkg:dist/index.d.ts:885-906` |
| 对所有 sandbox 都能用 `{ type: "head" }` | isolated provider 运行时拒绝；仅 bind-mount/no-sandbox。[实现](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/run.ts#L507-L520) |
| `docker({ branchStrategy: ... })` 或 `docker({ image: ... })` | branch strategy 属于 `run`/`interactive` 等调用；镜像字段是 `imageName`。`pkg:dist/sandboxes/docker.d.ts:14-108` |
| `run({ env: ... })` 或顶层 `onAgentStreamEvent` | 顶层 `RunOptions` 无这两个字段；env 放 provider 工厂，流回调放 `logging.type === "file"`。`pkg:dist/index.d.ts:456-490,502-588` |
| 流事件是 `{ type: "tool_call", args }` | 这是自定义 provider 内部 parser 的结构；公开回调是 `{ type: "toolCall", name, formattedArgs, ... }`。`pkg:dist/index.d.ts:60-76,256-272` |
| `await sandbox.dispose()` | 无此方法；用 `await sandbox.close()` 或 `await using`。`pkg:dist/index.d.ts:841-866` |
| `import { agy, kimiCode } ...` | 这些内置导出不存在；需自定义 `AgentProvider`。`pkg:dist/index.d.ts:1051` |
| 用 README 的 provider 段落断言没有 Daytona | 发布 `package.json` 实际导出 `daytona` 子路径；README 的部分列表不完整。`pkg:package.json:21-32`；`pkg:dist/sandboxes/daytona.d.ts:45-60` |

## 8. 本地 Harness 的认证、状态与代理证据

### 8.1 本机只读版本探测

- Codex CLI 0.163.0；Claude Code 2.1.114；Antigravity `agy` 1.4.0；Kimi Code 2.2.0；Pi 0.74.0（`/data1/code/pi-mono/pi-test.sh` 启动的源码 fork）。
- 宿主二进制不能等同于容器内可用：Codex 当前是静态 musl ELF，Claude/Antigravity/Kimi 是动态链接 ELF；Pi wrapper 还依赖 `pi-mono/node_modules/.bin/tsx` 和 `packages/coding-agent/src/cli.ts`（`pi-test.sh:57-63`）。应固定镜像内 CLI 版本，而不是只挂载 `~/.local/bin`。
- 本机 `agy --help` 与 `kimi --help` 均没有专用 proxy 参数；它们分别确认支持 `--conversation` 和 `--session` resume。代理 env 是否被实际网络栈采用仍须运行时探测，不能由参数存在与否反推。

### 8.2 Codex

- 当前平台以 `CODEX_HOME` 隔离会话，并将 `auth.json`、`config.toml`、`skills`、`plugins`、`rules` 从共享 home 链接进来（`src/lib/real-agents/codex-home.ts:7-35`）。Bubblewrap 让 per-job home 可写、共享 symlink 目标只读（`src/lib/harness/bubblewrap.ts:58-88`）。容器若只挂载 per-job home，绝对 symlink 会断；必须同时映射目标，或改变凭证播种方式。
- 代理由 `FEISHU_RUNTIME_CODEX_{HTTP,HTTPS,ALL,NO}_PROXY` 显式映射为大小写标准变量（`src/lib/real-agents/codex-agent.ts:140-173`）。应通过 agent 工厂 `env` 注入，不能依赖宿主 env 自动进入容器。
- Sandcastle 内置 Codex 使用 `codex exec --json`、stdin prompt 和 `exec resume/fork`，并有 JSONL session storage（[`src/AgentProvider.ts`](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/AgentProvider.ts)）。平台当前 Codex 还使用 app-server、interaction、steering、rate-limit 和 runtime telemetry；内置 Provider 可作为 S1 执行器，但不等于这些 ACPX 能力已对齐。

### 8.3 Claude / Claude-haha

- 每个 installation 有独立 binary、HOME、`CLAUDE_CONFIG_DIR` 和 env（`src/lib/real-agents/claude-installations.ts:21-55`）。默认 Claude 使用 `~/.claude`；claude-haha 显式使用 `/home/hello/.claude-haha`，不能共用配置目录。
- 代理映射与 Codex 相同，另外还拼接 NVM 和 installation 的 PATH（`src/lib/real-agents/claude-agent.ts:185-218`）。容器内应使用镜像内 Node/CLI，不依赖宿主 NVM。
- 内置 `claudeCode` 支持 stdin prompt、permission mode、resume/fork、主 session 和 subagent transcript 捕获，标准 Claude 可直接评估；claude-haha 仍需独立 Provider 配置以保留其 home/env 约定。

### 8.4 Pi

- 当前 adapter 不经过 Bubblewrap，直接继承宿主 env/文件系统；默认 CLI 是 `/data1/code/pi-mono/pi-test.sh`（`src/lib/real-agents/pi-agent.ts:42-66,240-244`）。因此“当前能跑”不证明容器只挂二进制也能跑。
- 凭证默认在 `~/.pi/agent/auth.json`，模型和设置也在 `~/.pi/agent`（`/data1/code/pi-mono/packages/coding-agent/src/config.ts:448-494`）。OAuth 刷新会加文件锁并回写 `auth.json`（`core/auth-storage.ts:397-440`），所以过期凭证不能被简单视为只读输入。
- 平台续跑目录为 `~/.acpx/pi-agent-sessions`（可用 `PI_AGENT_SESSION_ROOT` 改），通过 `--session-dir` / `--continue` 使用。该目录必须按参与者持久化且可写。
- Pi 代理由 `proxy-from-env` 解析，只支持 HTTP/HTTPS，不支持 SOCKS/PAC（`/data1/code/pi-mono/packages/ai/src/utils/node-http-proxy.ts:15-38`）。需将标准 proxy env 传进 CLI，而不是只传 `FEISHU_RUNTIME_*` 名称。
- Sandcastle 内置 Pi 的注释和命令针对 `@mariozechner/pi-coding-agent 0.73.1`，使用 `pi -p --mode json ... --session <id>`；本地是 0.74.0 fork，平台使用 `--session-dir <dir> --continue`。两者 session 文件布局与 ACPX continuation key 不同，内置 Pi 只能先做独立兼容性探针，不能直接替换现有 Pi adapter（[`src/AgentProvider.ts` 的 Pi provider](https://github.com/mattpocock/sandcastle/blob/v0.12.0/src/AgentProvider.ts#L637-L665)）。

### 8.5 Antigravity

- 自定义启动依赖 `agy -p`、`--output-format stream-json`、`--conversation` resume、`--project`/`--new-project` 和 `.gemini`（`src/lib/real-agents/antigravity-agent.ts:56-81,118-143`）。`.gemini` 当前是可写配置挂载，执行日志也写在其下。
- 项目绑定按宿主机 worktree realpath 查找 `.gemini/config/projects`。容器内必须保持相同路径，或由宿主计算项目 id；否则容易重复创建项目元数据。
- 代理同时接受标准变量和 `FEISHU_RUNTIME_*`，并补 `~/.local/bin` PATH（`antigravity-agent.ts:84-98`）。需要自定义 AgentProvider、事件解析、镜像和 `AgentSessionStorage`；只解析出 conversation id 并不构成跨沙箱恢复。

### 8.6 Kimi Code

- 默认 home 为 `~/.kimi-code`，CLI 通过 `KIMI_CODE_CLI_PATH` 可替换（`src/lib/real-agents/kimi-code-agent.ts:47-49`）。会话在 home/sessions 下；managed OAuth 凭证在 home/credentials 下（`src/lib/real-agents/kimi-code-telemetry.ts:334-350`）。home 必须区分共享凭证与 per-job 可写会话，不能只挂只读 home。
- 当前仅继承标准 env，没有 `FEISHU_RUNTIME_*` 到标准代理变量的映射；必须显式构造代理 env 并实测 CLI 是否遵守。
- 需要自定义 AgentProvider 和 `AgentSessionStorage`，并保留 `--session` resume、stream-json 解析、usage 遥测，以及 `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY=3` 和平台 SubAgent 上限（`kimi-code-agent.ts:187-201,313-335`）。`wire.jsonl` 的存在不能单独证明整份 session 只需一个文件即可恢复。

## 9. 共同接入约束

1. 不挂载整个 HOME，不把宿主机 `process.env` 全量交给容器。按 Provider allowlist 传递 HOME、配置目录、必要 API 身份变量和代理变量；代理 URL 中的凭据不得进入日志。Sandcastle 的 agent/sandbox env 同名 key 会冲突，应只在一个层设置。
2. 共享凭证只读与可写会话要分开；任何 OAuth 刷新路径都必须有测试。若需刷新，选择受控可写共享凭证（利用原生锁）或宿主凭证 broker，不能假设只读挂载永远够用。
3. 容器里的 `127.0.0.1` 不是宿主机代理。loopback 代理必须改为主机网关地址并配置 host-gateway，或使用明确的 sidecar/共享网络方案；同时保留 NO_PROXY 和 CA/hosts/resolv 配置。
4. 使用 Docker 的 `containerUid`/`containerGid` 等等价配置对齐宿主文件所有权，避免会话、worktree 和凭证文件被 root 写坏后续宿主访问。
5. 可复用 sandbox 不等于可恢复会话。自定义 Antigravity/Kimi Provider 必须实现 `captureToHost`、`resumeIntoSandbox`、`readHostSession`、`existsOnHost` 等完整存储契约；仅实现 `parseStreamLine()` 不够。
6. `run`/`sandbox.run` 的 `AbortSignal` 可桥接平台中断；但 `sandbox.exec()` 没有同样的 signal/timeout 契约，需另设测试命令超时。恢复要验证停止后利用原生 session 在新进程或新容器中 resume，而不是只连续调用两次 Promise。
7. 云端 Agent 调用本身需要网络。`safe_local` 当前的 restricted 无网络语义不能与云端复核直接画等号；需要明确 enabled、代理-only 或 egress allowlist 策略，不能在 Sandcastle 中静默放开网络后仍宣称权限等价。

## 10. Provider 与 worktree 的最终接入判断

### 10.1 Harness 顺序

| Harness | 0.12.0 接入判断 | 推荐顺序 |
|---|---|---|
| Codex | 内置 Provider 可执行并支持 resume；ACPX app-server、interaction、steering 和完整遥测仍需平台侧适配 | **S1 首选** |
| Claude | 标准 installation 可用内置 `claudeCode`；claude-haha 需独立配置 | Codex 之后 |
| Pi | 内置 Provider 与本地 fork/平台 session-dir 模型不一致；独立探针可试，替换现有 adapter 需自定义或迁移会话模型 | 标准 Claude 之后 |
| Antigravity | 无内置 Provider；需自定义命令、事件、`.gemini` 项目状态和完整 session storage | 后续独立 Slice |
| Kimi Code | 无内置 Provider；需自定义命令、事件、可写 home、完整 session storage 和 SubAgent 限制 | 后续独立 Slice |

### 10.2 原方案不能同时得到的两项能力

- **直接使用平台已有 worktree**：用 bind-mount/no-sandbox 的一次性 `run({ cwd: workspace.path, branchStrategy: { type: 'head' }, ... })`。不会创建嵌套 worktree，也不会合并回宿主其他分支，但该调用不返回可复用的 `Sandbox` 句柄。
- **同一暖沙箱交替执行 Agent 和测试**：用 `createSandbox()` 后可调用 `run()`/`exec()`，但它固定创建或复用 `.sandcastle/worktrees` 下的 managed worktree，不能通过 `branchStrategy: { type: 'head' }` 改为采纳平台外部 worktree。

因此，“平台独占 Job worktree 生命周期”与“同一 Sandcastle 暖沙箱多步执行”在公开 API 下不能按原伪代码同时成立。可选路径只有：

1. **S1 最小路径**：保留平台 worktree，使用一次性 `run(head)`；测试仍走现有 staging 验证，不追求暖沙箱 `exec()`。
2. **后续完整路径**：实现能采纳外部 worktree 的自定义 sandbox/生命周期封装，或推动上游增加相应 API。若改让 Sandcastle 创建 managed Job worktree，则必须重写平台当前对 Job path/branch 的记录与集成假设，不是只改一行调用。

### 10.3 平台边界与 S1 验收

- 不建议整体替换 `executeAcpxTaskRun`：它还负责 TaskRun 事件、会话元数据、权限、遥测、进程控制和各 Harness 的 resume。应在现有 HarnessAdapter/Runner 边界接入 Sandcastle，并保留平台 integrationRef、仓库锁和原子集成。
- `sandbox.exec` 在同一热沙箱中只能验证 Job worktree。平台当前在合并后的 detached staging worktree 再执行 `verify(stagingPath)`，通过后才原子推进 integrationRef（`src/lib/task-graph/worktree.ts:250-361`）。该合并后验证不可被 Job 沙箱测试替代。
- 独立架构/验收复核应使用单独只读沙箱和固定提交工作区；不能默认复用实施者的可写热沙箱，否则角色隔离和“复核未污染工作区”断言会被削弱（`src/lib/task-graph/coordinator.ts:188-209`）。
- S1 不需要先写自定义 AgentProvider。建议以镜像内固定版本 Codex + 内置 Provider + `run(head)` 验证：订阅身份来源、代理必经、text/tool/raw 流到 ACPX、AbortSignal 中断、session 捕获与新进程 resume、无嵌套 worktree、提交后现有 staging 检查及原子集成。
- 五种 Harness 均应补认证过期/刷新、凭证及会话文件所有权、代理直连阻断、CLI 版本和 resume 测试；不能以一次成功 stdout 或 Typing 事件代替这些验收。

## 11. 复核边界

本复核执行了包元数据/完整性校验、发布 ESM 导出与 provider 工厂的真实 import、类型声明检查、发布 source map 与官方 tag 的逐字比对，以及行为实现走读；另对本机五种 CLI 做了只读版本/help 探测，并核对平台与 Pi fork 的认证、配置和会话源码。未启动真实容器、云端 sandbox 或付费 agent，因此订阅刷新、代理必经和容器内实际认证仍列为实施验收项，而不是本轮已完成事项。
