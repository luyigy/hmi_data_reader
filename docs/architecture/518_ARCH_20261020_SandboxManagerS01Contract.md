---
doc_type: ARCH
doc_status: draft
---

# Sandbox Manager S01 架构合同

## 结论与调查范围

固定基线为 `oss-prep@72a86b0b6c7922270f04a48e24866a1369db72e6`。调查时 `gitee/oss-prep` 与本地 HEAD 一致。本文是待审合同，本轮只增加文档，未实施下述接口、运行生产验收、部署或恢复 Ticket。

S01 的交付是让一条真实本机 Codex Ticket 实施入口，通过统一 Manager 执行 Bubblewrap，并证明与现有权限和会话行为等价。Manager 接收宿主已批准并完成装配的计划，只管理本次沙箱进程及自己创建的临时资源。批准 Ticket、授权资料、推进阶段和接管 Writer 仍由原模块负责。

架构方向如下，Harness Adapter 仍负责模型协议：

```text
Ticket Orchestrator → Coordinator → ACPX Runner
                                      ↓
                              Codex Harness Adapter
                                      ↓
                                Sandbox Manager
                                      ↓
                              Bubblewrap Backend
```

未来 Backend 可以增加 gVisor。本期接口只承诺本机 Bubblewrap，不定义镜像、容器、资源池或调度器，不虚构跨后端通用的 PID 证明。

## 已查明的实际调用链

下列行号均对应固定基线。代码路径是事实依据，不把设计接口写成既有能力。

| 入口与证据 | 当前职责与约束 |
| --- | --- |
| `src/lib/acpx/runner.ts:48`、`:131`、`:203` | 创建并持久化 GraphWriter；为 graphExecution 安装 steering；participant 与外围服务清理后才释放 supervisor。 |
| `src/lib/acpx/runner-harness.ts:153`、`:172`、`:207` | 汇总工作区、Git 元数据只读边界、上游、输出、材料、技能和运行环境；进入项目资料接口及临时服务作用域；向 adapter 传递上下文。 |
| `src/lib/harness/adapters/codex.ts:38`、`:81`、`:142` | 增补 Codex 共享配置只读路径；决定内层 Codex 参数；execute/resume 保留原生 Session 和 telemetry。工作区由外层 Bubblewrap 保护时，内层可使用 danger-full-access，不能误当成外层无限权限。 |
| `src/lib/real-agents/codex-agent.ts:146`、`:198`、`:266` | 装配子进程环境与模型代理；有 steering 或 on-request 时选 app-server，否则选 JSON。 |
| `src/lib/real-agents/codex-app-server.ts:145`、`:157`、`:169` | 编译 Bubblewrap 命令后直接 spawn，通知 onSpawn；后续自行处理 RPC、stdio、Session、审批与交互。真实 graphExecution 会安装 steering，通常走这里。 |
| `src/lib/real-agents/codex-agent.ts:412` | JSON 分支也独立 wrap、spawn。只替换这里会漏掉真实 Ticket 的主要路径。 |
| `src/lib/harness/bubblewrap.ts:37` | 尚不是生命周期管理器。混合项目 Python 选择、路径解析、输出绑定验证、环境变量清理规则与 bwrap 参数生成，只返回 command/args。没有启动、停止、回收。 |
| `src/lib/task-graph/runtime-continuity.ts:75`、`:121` | 依当前候选、claim、授权及固定资源建立快照，事务内复核归属与资源声明；不能移入 Manager。 |
| `src/lib/task-graph/runtime-preflight.ts:31`、`:75`、`:97` | 解析已批准目录内的版本化 browser/OCR/skill，验证完整技能包和实际浏览器，保存资源回执；不是新的权限授权入口。 |
| `src/lib/project-capabilities/context.ts:10`、`policy.ts:19` | 读取宿主控制的项目策略，交集到已获批路线范围，并验证用户、任务及当前 claim。仓内声明不能自授宿主目录。 |
| `src/lib/project-capabilities/runtime.ts:23`、`:43`、`:117` | 按轮创建资料 Unix socket、动态重新授权、缓存已选图片；finally 关闭接口并移除该 socket 目录。宿主凭据不交给模型。 |
| `src/lib/task-graph/writer-ownership.ts:21`、`:54`、`:110` | GraphWriter 是 runner supervisor 的 host/uid/boot/startTime/ancestry/nonce 身份；观察 supervisor 和所有带 nonce 的后代，区分 alive/exited/unknown。不是 bwrap PID。 |
| `src/lib/task-graph/writer-snapshot.ts:12`、`:26` | 把退出观察与当时的 execution/TaskRun 快照绑定，事务内再次比较，不能用 Manager exit 事件替代。 |

`canRetryCodexAppServerWithJson` 在 `codex-app-server.ts:55` 明确要求没有 workspaceRoot。受限 Ticket 的 app-server 失败不能回退 JSON，更不能回退宿主执行。S01 保持这个限制。

### 其他直接调用者

源码检索得到以下生产调用者，不能因只迁移 Codex 就另留一份权限解释：

- `real-agents/claude-agent.ts:299`、`kimi-code-agent.ts:356`、`antigravity-agent.ts:134`、`deepseek-runtime.ts:127`。
- `task-graph/check-environment.ts:47`，平台检查，源码只读、指定输出可写；当前网络为 enabled。
- `task-graph/runtime-preflight.ts:97`、`skill-resource-preflight.ts:22`，预检，源码只读、网络 restricted、无模型凭据。
- `task-graph/attempt-services.ts:103`，短期联调服务，单独数据目录、监听归属与健康检查；服务清理在 `:146`。它不是模型进程。
- Review/Architecture 通过同一个 runner-harness 调用对应 Harness。remote SSH、remote runner、OpenClaw gateway 有独立入口，不自动经过本机 Bubblewrap。

### 已有边界的历史原因

提交 `c0f538c` 明确把 Writer 释放延后到 metadata 与服务清理之后。`bc59a97` 和 `cb0c054` 增加祖先身份与独立进程来源证明。`86653fa` 将获批项目能力延伸到检查与跨仓 Review。A/B 的 `0b316f2`、`c1e1d9d` 则补齐技能包和原实施会话续接。S01 保留这些约束，不重置它们。

GitNexus 的本仓索引落后 HEAD 188 个提交，impact 查询还因只读数据库无法回放 shadow pages 失败。本轮没有重建索引，依赖清单以当前源码的 import、调用及 Git 历史为准。未从不可用的图索引推断“没有调用者”。未查询外部聊天、工单或监控系统；本文的历史解释仅依据本地提交和已存合同，不声称还原所有作者动机。

## 职责分配

| 内容 | 所有者 | S01 处理 |
| --- | --- | --- |
| 路线批准、输入授权、项目策略与撤销、预算 | Task Graph / project-capabilities | 保持原位置；Manager 不接收数据库 client 或审批命令。 |
| candidate、claim、revision、固定运行资源回执及完整技能预检 | Task Graph | 原位置；接近 spawn 时的资源复核继续存在。 |
| 源仓身份、上游与材料选择、输出声明允许哪些路径 | Task Graph | 原位置；向装配层提供已核验的路径和绑定。 |
| 已批准资源的路径规范化、Python 调用路径、环境变量清理、挂载顺序 | 共享 Environment Preparation | 从现有 Bubblewrap 混合函数按职责提取，一份实现供新旧入口使用。 |
| `/usr`、proc/dev/tmpfs、证书/DNS 映射、namespace、bwrap 可执行文件与参数 | Bubblewrap Backend | 后端私有实现。维持当前 flags、顺序和现有系统工具可见范围。 |
| 一次 spawn 的 stdio、控制信号、根进程身份、退出观察和自身资源回收 | Sandbox Manager / Backend | 新增这一层；不接管 Session、会话输入或阶段状态。 |
| Codex CLI/RPC 协议、thread/resume、审批与消息解析 | Codex Harness | 保持原位置；只替换进程边界。 |
| task HOME、模型登录状态、skill/config 共享链接 | Harness runtime | 保留 `harness-runtime.ts` 生命周期；Manager 不能在每轮结束时删除原 Session。 |
| 资料 socket、已选图片、上游临时服务、输出归档与 worktree | 各原所有者 | Manager 只消费现成挂载/环境。不能清理其他模块或用户资源。 |
| writer exited 的最终判断与恢复 CAS | Writer Ownership / Task Graph | 保持原观察和恢复机制；Manager 的根进程退出只作为补充证据。 |

Environment Preparation 不等于“自动找目录就授权”。它只能把上层核准的资源与既有宿主基础运行契约转换为确定计划。现有 `localToolchainPaths()` 暴露的宿主工具目录、`projectEnvironment()` 的历史推断、非 strict 模式的 symlink 展开都是必须记录的兼容行为，不借重构悄悄扩大或收紧。

`output-bindings.ts` 仍负责受控输出绑定的防逃逸、不能遮盖 tracked input 等验证。准备层调用它，Backend 仅渲染经过验证的绑定。S01 不把这些规则再抄一份进 Manager。

## 最小接口与运行身份

以下是设计草图，不新增源文件。本期公开调用只需要“执行一次沙箱作用域”，不提供 list、调度、领取任务、重试或恢复 API。

调用者先形成完整计划，然后使用进程句柄执行原协议：

```ts
// Codex 协议入口已经拿到批准后的上下文，保留原 env builder。
const spec = prepareSandboxSpec(approvedResources, {
  executable: 'codex', argv: ['app-server', '--stdio'],
  cwd: runtimeCwd, env: buildCodexChildEnv(/* 原参数 */),
});
return withSandbox(spec, async process => {
  onSpawn(process.control); // 原 ACPX registry 仍负责按 participant 寻址。
  // 原 RPC/stream/Session 逻辑消费 process.io，不迁入 Manager。
  return runExistingCodexProtocol(process.io);
});
// JSON execute/resume 使用相同作用域，argv 由原 Codex builder 生成。
// 旧调用者继续 wrapWithBubblewrap(oldArgs)，只共用计划准备与渲染器。
```

最终装配位置固定在受信的 Codex Adapter 内。把其已有 `resolveWorkflowCodexBoundary`、`codexReadOnlyPaths` 和内外层 sandbox 区别收敛为一个内部 `prepareCodexInvocationContext(context)`，每次 execute/resume 各调用一次，保持现有 workflow override 的优先级。Runner 只决定是否接入 Manager 并提供已批准资源，不再计算第二次 Workflow 边界。随后原 Codex env builder 完成 provider 环境，协议入口用这些最终值构造 spec，构造后不再 overlay cwd/env/roots。JSON 与 app-server 消费同一最终上下文，不再各自解析 Workflow 快照。旧入口也使用该同一 helper，不能复制两套解释。

上面的 `prepareSandboxSpec` 是共同 Environment Preparation，不在其内读取 Ticket 或 Workflow 授权。它只能接受上述宿主装配结果。对受控 `AP_*`、运行 HOME 与路径的额外覆盖应在 spec 封存之前核对来源；封存之后不接受任何 env overlay。原 Adapter 若曾覆盖部分 readOnlyPaths，应先按原优先级建立基线，本期不借迁移改变该行为。

### 数据与接口草图

```ts
type Mount = Readonly<{
  source: string; target: string; access: 'read-only' | 'read-write';
}>;
type SandboxSpec = Readonly<{
  version: 1;
  backend: 'bubblewrap';
  cwd: string;
  command: Readonly<{ executable: string; argv: readonly string[] }>;
  mounts: readonly Mount[]; // 有序，后置的只读覆盖不能排序或去掉。
  network: 'restricted' | 'enabled';
  environment: PreparedEnvironment; // 内存中的完整 env、清理和覆盖计划。
  runtimeIdentity: string | null; // 原资源快照身份，不是进程身份。
}>;
type SandboxIdentity = Readonly<{
  version: 1;
  backend: 'bubblewrap';
  host: string; uid: number; bootId: string;
  supervisor: Readonly<{ pid: number; startTime: string }>;
  root: Readonly<{ pid: number; startTime: string }>;
}>;
type StopRequest = Readonly<{
  signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL';
  deadlineMonotonicMs: number; // 有限的宿主单调时钟截止值。
}>;
type RootExit =
  | { kind: 'exited'; identity: SandboxIdentity;
      code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'unknown'; reason: string };
type SandboxProcess = {
  identity: Promise<SandboxIdentity>;
  io: ProcessIO; // stdin/stdout/stderr 和协议需要的本进程事件。
  control: ProcessControl; // 与 ACPX 原 kill/exitCode 控制契约兼容。
  stop(request: StopRequest): Promise<RootExit>;
};
function withSandbox<T>(spec: SandboxSpec,
  use: (process: SandboxProcess) => Promise<T>): Promise<T>;

// 后端接口是内部边界，不供 Task Graph 导入。
interface SandboxBackend {
  readonly kind: 'bubblewrap';
  start(spec: SandboxSpec): BackendProcess;
}
```

`BackendProcess` 内部提供本进程的 IO、身份捕获、发信号、等待 close 及资源释放能力；Manager 负责把它们组织成单一作用域。`ProcessIO`、`ProcessControl` 只需要现有 Codex 消费的流、事件和控制成员，本期可在边界适配 Node ChildProcess，不把 PID 和 ChildProcess 定义成未来所有后端的通用协议。未来后端若无法提供宿主 Writer 可识别的证明，应报告 unsupported/unknown，必须先另定证明合同。

`PreparedEnvironment` 复用现有环境规则，不新增一份 allowlist。最终的 HOME、CODEX_HOME、代理和模型变量由 Harness 组好后一次绑定到 spec。资源相关 `AP_*` 值必须与 approvedResources 相符；不得在 Manager 接收计划后再用一个 arbitrary env 覆盖资源绑定。不能把 env、token 或完整启动参数写入公开身份与日志。

草图中的 approvedResources 是受信宿主调用链装配的内部值，不接受 Agent JSON 自称已批准。类型上的 readonly 或品牌不是授权证明，真正权限仍由上游原检查保证。Manager 只核对计划内部一致性、路径有效性和后端是否能执行，不向 project policy 申请更多资源。

### stop、退出与 cleanup

1. spawn 后立即建立 error/exit/close 监听，捕获宿主 root PID 与 startTime。不能等 RPC 初始化完成后才追踪进程。启动错误或身份捕获失败也必须进入同一清理路径。
2. 原有 interrupt 继续表达 SIGINT，stop_run 继续表达 SIGKILL。协议超时和正常 app-server 收尾原先用 SIGTERM，保持其信号含义。`control.kill()` 只能表示信号已请求，不能设置“已退出”。现有 registry 的 applied 不等于退出证明。
3. 所有已迁移入口的 kill，包括 runner service abort、registry control、协议 timeout 与 finally，必须使用同一个 Manager 控制句柄；不能给 registry 一个 raw child，又让 Manager 以为自己独占 stop。onSpawn 的 PID、TaskRun/participant 归属保持不变，不另建全局 registry。
4. stop 复核本进程句柄对应身份，等待真实 close，返回 RootExit。stop 重复调用共享根进程 close 观察及一次 cleanup，但每次控制请求仍单独处理其信号。先 SIGINT/SIGTERM、后 stop_run 的 SIGKILL 必须送达，即使前一次等待已返回 unknown；各次有限等待可以返回自己的 unknown，不能缓存第一次 stop Promise 后屏蔽后续信号。StopRequest 必须有有限单调时钟截止值；显式 stop 使用调用者指定值，正常返回、异常和启动失败的 finally 默认最多收尾 5000ms。这个值是拟定的资源清理上限，实施时必须通过忽略 SIGTERM 的夹具验证；不是固定等待，close 发生即结束，也不是退出证据。期限内无法证明、进程身份变化或观察失败均返回 unknown，不当作成功。超出期限不自动重试或升级信号，只有原 stop_run 才选择 SIGKILL。该技术上限不增加或重置 Graph 恢复预算。
5. 不能直接采用 `process.kill(-pid)`。当前 bwrap `--new-session` 是沙箱内部会话选项，不证明宿主 child.pid 等于可安全终止的进程组。若采用进程组控制，实施者必须先给出宿主 PGID 归属与 PID 重用测试；否则维持本进程信号与 Bubblewrap namespace 清理语义。
6. callback 正常返回或抛错都执行 stop/reap；确认根进程结束后清理本次 Manager 自建的资源。若未知则返回带身份的错误并保留现场，不移除仍可能在用的资源。不覆盖原始协议错误，应保留原错误和清理失败。
7. RootExit 只证明这次沙箱根进程，不能证明整个 Ticket Writer 已退出。GraphWriter 还覆盖前置服务和其他带 nonce 的后代。原 `observeGraphWriter`、`observeExecutionWriter`、`writerSnapshotMatches` 和恢复 CAS 继续决定能否接管。
8. Manager 不调用 `releaseTaskRunWriter`。原 runner 仍在 capability socket、services、metadata 清理结束之后释放 supervisor；原 nonce 扫描继续防止根进程结束而后代仍存活时提前领取。supervisor release 也不能替代后代退出证明。
9. Manager cleanup 不删除 worktree、共享依赖、技能包、材料缓存、阶段输出、task HOME 或 Codex Session。S01 没有创建这些资源，因此这部分 cleanup 可以没有删除操作。需要保留的 Session 与 attempt 临时资源不能混为一类。

当前 JSON timeout 在发 SIGTERM 后立即 reject，app-server finally 发 SIGTERM 后也不等待 close。S01 要把已迁移路径的收尾纳入上述作用域，补齐根进程收尾证据。业务结果、Session 和权限应等价，但不承诺“返回时机也与旧路径相同”。原 Writer 扫描继续保底，不为追求旧时序保留这个空档。

## 迁移范围与文件边界

选择条件只在 `runner-harness.ts` 一处决定，使用已有 `request.graphExecution`、`platform_local`、`harnessType === 'codex'` 及受限工作区。Review/Architecture/Discussion、普通房间聊天、remote 和其他 Harness 不凭 taskId 前缀误入。相同 Ticket 的 execute 与 resume 都走同一选择，不能只迁首轮。

| 文件 | 预计变更 |
| --- | --- |
| 新 `src/lib/sandbox-manager/environment.ts` | 提取确定计划准备；调用既有 project-environment、pinned Python、output-bindings、sandbox-env，保持唯一解释。 |
| 新 `src/lib/sandbox-manager/bubblewrap.ts` | 内部唯一 bwrap 渲染器与后端启动实现，含本后端 namespace/系统挂载。 |
| 新 `src/lib/sandbox-manager/index.ts` | 最小 spec/identity/handle 合同与 withSandbox，拥有本进程的生命周期。不先拆通用 registry、factory、provider 层。 |
| 原 `src/lib/harness/bubblewrap.ts` | 兼容门面，旧签名与无 workspace 直通保持；调用同一个准备函数及后端渲染器，删除原重复规则主体。不能 Manager 调旧 wrap、旧 wrap 又调 Manager 形成环。 |
| `src/lib/acpx/runner-harness.ts` | 仅在上述实施路径绑定 approvedResources 与 Manager 入口；保持原外围能力和服务作用域。 |
| `src/lib/harness/types.ts`、`adapters/codex.ts` | 加一个可选的进程执行端口传递到 Codex。其他 adapter 不实现它，不增加多层同名 forwarding 类。 |
| `src/lib/real-agents/codex-agent.ts`、`codex-app-server.ts` | 已选路径的 execute/resume、JSON/app-server 使用同一端口；把原 spawn/stop 收尾接入作用域，原 CLI/RPC 解析和 fallback 条件不变。旧调用无端口时保留原协议入口。 |
| `src/lib/acpx/process-registry.ts`、`runner-participant.ts` | 复用已有进程表接受 Manager control；修正 participant 成功和失败两处无条件清除登记。unknown 时保留控制句柄，只有 close 后按 TaskRun + participant + 该句柄身份比较删除，旧 close 不能误删新运行。旧入口的清理语义不变。 |

`runtime-preflight.ts`、`runtime-continuity.ts`、project-capabilities、Writer Ownership、Coordinator/restart-recovery 在 S01 原则上零行为修改；它们是回归与依赖证据。若实施需要改这些模块的状态或授权语义，应退回本合同审查，不顺手扩大范围。

端口经过 runner、adapter、Codex 协议是当前必要调用链，不再增加 manager-facade → service → provider → backend 多层包装。Manager 必须实际负责退出/停止/资源作用域，不能只是把 wrapWithBubblewrap 改名。

## 新旧路径兼容

统一的是底部资源准备和 bwrap 编译；分阶段迁移的是进程生命周期的调用者。两者不能混淆。

- 旧 wrap 保持 `{ command, args }` 返回值，不强迫所有 execFile/spawnSync 调用者立刻异步化，也不替它们启动进程。
- Manager 与旧 wrap 都消费唯一 Environment Preparation 及 renderer。旧路径不能保留原权限编译函数副本，新路径也不能再实现另一套 sandbox-env、Python 或输出规则。
- 现在 strict 由 `strictReadOnlyRoots` 或 capability socket/JSON 触发；非 strict 旧路径会补充直接 symlink 目标。提取后完整保留两种现有输入语义，不把“legacy”改成新授权通道。新 Ticket 不能主动降级 strict。
- 原无 workspace 的 full_access 直通仅留旧门面。Manager 的受限 Ticket spec 必须有有效工作区，后端失败不得直通宿主。
- 原内层 Codex sandbox、approvalPolicy 和网络设置照旧。外层 spec 不能把内层 danger-full-access 解释为脱离 Bubblewrap。
- 资源 hash 与 claim pin 仍由原 A/B 和 C01/C02 规则保证；Manager 的 plan 摘要不取代它们。禁止按任务名或提示词决定权限。
- 在源码边界测试中限制新直接 import renderer 的调用点；新增调用者使用公共入口。兼容旧调用者清单由检索生成，不维护另一份手写调度表。

这里接受临时存在新旧生命周期入口，换取不同时改所有 Harness/Review；不接受新旧两套权限解释。未来迁移其他调用者不需要重新定义政策。

## 红绿回归与等价性验收

以下是后续实施必须提供的证据，本轮没有执行这些测试，也不宣称已有 Manager 测试通过。红测针对新增边界与行为，不删除原断言，不通过扩大 timeout 或多轮轮询制造通过。

| 场景 | 红测应捕获的错误 | 绿测必须证明 |
| --- | --- | --- |
| 实际 ACPX Codex Ticket 启动与补料续接 | Manager 从未被调用，或只改 JSON 漏掉 app-server | 真实 runner → adapter → app-server 两轮走同一 Manager，原 thread/sessionKey、私有 HOME 和输入绑定不变。 |
| 根进程收尾 | 协议已返回、注册已清除，但子进程仍存活 | 正常、异常、超时、SIGINT、stop_run、service abort、重复 stop 都能追踪根进程；信号请求不冒充退出。 |
| unknown、存活后代、宿主重启 | 只凭 close、lease 或 elapsed time 放行新 Writer | 真实存活 nonce 后代阻止接管；无法观察为 unknown；实际退出后才由原快照/CAS 放行。不用伪造 PID。 |
| 资源计划被晚覆盖 | 改 AP_PROJECT_*、output bindings、HOME 或 roots 后扩大挂载 | 完整 env 与最终已核验资源绑定一致；不一致拒绝，不能从失败的新入口回退宿主。 |
| strict 与旧 symlink | strict 降级、自动递归暴露技能链接目标、旧调用意外变严 | 同一编译器分别复现两种既有行为；完整技能包的获批依赖在实际 Bubblewrap 中可用。 |
| 挂载顺序与工作区 | Git/共享依赖意外可写，输出覆盖 tracked input | 工作区可写，.git/common-dir、技能、原图、上游及共享依赖只读；输出只在原批准绑定内可写。 |
| 环境、代理与网络 | 模型凭据泄露给检查，Python 调错解释器，网络静默放宽 | 模型入口保留原认证；检查仍移除凭据；项目 venv 调用路径、网络 namespace 和代理与基线一致。 |
| 旧入口 | 所有 review/其他 Harness 被改成新生命周期，或旧门面另编权限 | 未迁移调用保持原行为；新旧用唯一准备器和 renderer；无 workspace 直通仅在旧路径。 |
| 资源/授权变化 | Manager cache 复用旧资源，或先调用模型后发现 skill 缺失 | 原 runtime hash、claim pin 和撤销检查仍 fail closed，失败前模型调用数为零。 |

### 证明方法

1. 在隔离 worktree 和独立测试数据库固定基线，对相同的临时仓库、假 Codex 可执行文件和真实 Bubblewrap 采集基线与候选。假 Codex 只用于可重复协议与权限夹具，不代替最终真实 Codex 验收。
2. 从实际 spawn 处采集 command/argv/cwd、有效挂载及环境，在受保护的临时测试内比较。只归一化临时根目录、随机 socket/token、PID 和时间；不能归一化 mount 顺序、read-only/read-write、strict、网络或资源 hash。公开日志只保存非秘密差异与结果，认证值使用固定假凭据，不保存宿主真实 env。
3. 在沙箱内实际探测文件读写和拒绝行为、Python executable、技能 checker、模型 HOME/config、Git metadata、输出别名。完整 poteto checker、mapping 和 playbook 都执行，不能只测 SKILL.md 可读。
4. restricted 通过隔离网络 namespace 中的实际连接失败证明；enabled 用隔离夹具宿主本地服务证明连通。不访问生产服务，也不把 enabled 描述为域名白名单。它目前是共享宿主网络。
5. 用假 app-server 的完整 initialize/thread/start/resume/turn 流验证 steering、stream、Session、stop 和 callback 顺序。restricted app-server 失败不得试 JSON。JSON 分支用隔离独立测试覆盖，不篡改真实 Ticket 的选择条件。
6. 停止夹具要包括忽略 SIGTERM、先 SIGINT/SIGTERM 后 SIGKILL、先 unknown 后再次 stop_run、根进程退出但后代存活、PID 重用/bootId 不符、观察权限失败和父进程崩溃。Manager root receipt 与原 observeTaskRunWriter 的观察分别记录，不能用二者同名的 exited 混淆事实。
7. 最后提议一条全新的专用测试路线，由用户原生确认卡批准后执行真实 Codex + 飞书 Topic。先缺材料，正常回复补料，沿原 Agent/Session 实施；独立 Review 继续旧路径；验收通过放行后继。只创建测试仓，不能恢复现有生产 Ticket。记录启动确实走 Manager、输入只消费一次、原生 Session、资源身份、writer nonce 与正常释放时序、candidate、claim/revision、回修次数及后继放行时间。

现有应复用的回归包括 `bubblewrap.test.ts`、`codex-tool-package.test.ts`、`codex-home.test.ts`、`real-agents/codex-app-server.test.ts`、`task-graph-sandbox`、`task-graph-output-runtime`、`task-graph-runtime-pinning`、`task-graph-runtime-continuity`、`task-graph-skill-runtime`、`project-capabilities-c01/c02`、`task-graph-writer-ownership`、`task-graph-process-lineage`、`task-graph-service-execution`、`task-graph-continuation-eligibility`、`task-graph-interactive-conversation` 及重启恢复系列。按测试脚本的既有隔离入口执行，不对生产 DB 跑回归。

新增测试集中在 `tests/sandbox-manager.test.ts` 和一个 ACPX Codex Ticket 集成测试；若既有 app-server 测试可承载，不另复制整套协议夹具。首个有意义的红测是“协议结束但 bwrap 仍存活时执行作用域不能声称清理完成”。

### 完成标准

- 首条真实 Codex Ticket 的启动与续接已通过 Manager，app-server 的选择和安全失败条件保持。
- 同场夹具的新旧权限、技能、环境、挂载、网络、会话和 Writer 保护等价；收尾时机的有意变化单独记录。
- Manager 没有 Prisma、Task Graph 状态推进、项目策略审批或权限扩展依赖。仅使用上游批准结果，没有新的预算、Prompt 规则或全局进程表。
- stop、启动失败和取消均有根进程证据；Writer 最终接管仍用原证明与 CAS，unknown 不放行。
- 其他 Harness/Review 的兼容回归通过。旧 wrap 是同一编译器的门面，不再保留权限规则主体。
- 后续实施报告保存红绿测试、实际作用域调用证据及真实测试路线结果；代码审查不能只看“新增 Manager 文件”。

## 方案选择与风险

依 architect 技能比较了两个独立设计，均只读调查。候选 A 由 gpt-6-sol 提出一次运行的 launch/control 生命周期，候选 B 由 gpt-6-astra 提出完整 prepared launch 值、adapter 保留 spawn。独立审查由 gpt-6.1-sol 完成。

按生命周期归属、唯一权限解释、真实路径覆盖、Writer 兼容、接口及验证五项各 5 分评分，A 得 21/25，B 得 18/25。选 A 的生命周期边界，采用 B 的共享 preparation/renderer 和完整环境绑定。拒绝 B 的 prepare-only 形态，因为它没有承担用户要求的 stop/cleanup，仍留两处协议各自管进程。也不采用 A 将 executionId/claim/revision 传入 Manager 或让 Manager 编译 Workflow 政策的部分，这些属于上层。

审查指出的三个缺口已纳入本合同：明确有限停止期限；补列 runner-participant 的条件清除登记；固定唯一 Codex 最终上下文装配点。源码和接口复核完成，未执行实现测试。候选原稿是本机临时调查材料 `/tmp/sandbox-s01-candidate-a.md`、`/tmp/sandbox-s01-candidate-b.md`；可审查的合并结论保存在本节，不依赖临时文件继续存在。

接受一次实施路径的有限生命周期迁移，换取可以单独验证；接受旧门面以支持同步检查调用者，但权限规则主体必须同时提取。拒绝将 Manager 包在 adapter 外面只改名字、通用后端注册中心、Manager 持久会话表及全调用者一次迁移。

本合同尚未实施；设计偏离须先在本节说明并修改受影响的接口和验收边界，不能在实施报告中追认。下一实施起点是固定基线的隔离生命周期红测，再提取唯一准备器与 renderer，最后接入这一条 Codex Ticket 入口；本轮不启动该工作。

本期不承诺依赖内容的原子冻结。现有 realpath/hash 校验与实际 mount 之间仍有宿主更新窗口；提取不得增加缓存或延后验证扩大窗口。项目 Python identity 只固定当前已有解释器与配置身份，不是整个包目录的内容摘要。未来若要求原子资源句柄或完整不可变环境，应另定交付。

本轮检查只有源码与 Git 历史调查、远端 HEAD 核对及 `check:long-files`。没有以 A/B 已通过推导 S01 已通过。
