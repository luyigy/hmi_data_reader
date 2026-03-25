# 37 ACPX Live Room Remote Interrupt Normalization And True Session Continuation Handover

## 日期
2026-03-25

## 本文目的

记录当前 `Live Room` 在 Phase 1 之后的新状态，并明确两件下一步必须处理的事情：

1. remote interrupt 之后，UI 不应再把 SSH warning 当作“失败原因”展示给用户
2. `remote_ssh` 不应继续采用“每条消息都重新 spawn 一次 claude/codex”的模型，而应尽快设计真正的 remote session continuation

## 当前已完成状态

本轮已经完成的 Phase 1 结果：

1. `remote_ssh` member 在 `Live Room` 内变成单 member 单 active job
2. 同一 remote member 的旧 pending delivery 会被 `superseded`
3. remote child process 现在有明确 ownership / registry
4. stale remote delivery 会被清理
5. UI 现在可以区分：
   - `queued`
   - `running`
   - `stalled`
6. UI 现在新增了“请求中断远端回复”按钮

相关文件：

- [live-room-process-registry.ts](/data1/code/agent-platform-v2/src/lib/live-room-process-registry.ts)
- [live-room-delivery.ts](/data1/code/agent-platform-v2/src/lib/live-room-delivery.ts)
- [live-room.ts](/data1/code/agent-platform-v2/src/lib/live-room.ts)
- [interrupt route](/data1/code/agent-platform-v2/src/app/api/live-rooms/[id]/interrupt/route.ts)
- [LiveRoomWorkspace.tsx](/data1/code/agent-platform-v2/src/components/live-room/LiveRoomWorkspace.tsx)

## 新发现的问题 1：interrupt 后错误文案不对

### 用户观察到的现象

点击“请求中断远端回复”后，房间里出现系统提示：

- `系统提示：TX-server Claude 本次回复失败：Warning: Permanently added '10.0.8.10' (ED25519) to the list of known hosts.`

### 这说明什么

这不代表 interrupt 没生效。

真实过程更像是：

1. UI 调用了 interrupt API
2. 后端向当前 running 的 SSH child 发出 `SIGTERM`
3. SSH / remote harness 提前退出
4. 退出路径仍然落入当前的 generic failure handling
5. stderr 里恰好带有 host key warning
6. 该 warning 被当成最终 fallbackReason 展示到房间系统消息里

也就是说：

- **interrupt 动作本身是生效的**
- 但**错误归因文案仍然不正确**

### 为什么这是问题

这会给用户错误心智：

1. 看起来像 SSH 配置坏了，而不是“我刚刚手动中断了它”
2. 会把 harmless warning 误判成真实失败根因
3. 让 interrupt UX 显得不可信

### 下一步建议

应当补两层规范化：

#### A. interrupt 要有专属终态

不要让用户主动 interrupt 最终落到 generic `failed` + raw stderr。

更合理的是在 `Live Room` 内部单独区分：

- interrupted by user
- cancelled before execution

至少用户可见文案应改成：

- `系统提示：已中断 TX-server Claude 当前远端回复。`
- `系统提示：已取消 TX-server Claude 的排队回复。`

#### B. strip 掉 SSH known-host warning

像下面这种文案不应出现在 room-visible failure reason 里：

- `Warning: Permanently added '...' to the list of known hosts.`

它更适合：

- 只留在内部 stderr / debug log
- 或在标准化后从最终用户文案中移除

## 新发现的问题 2：当前 remote 不是“继续会话”，而是“每轮新进程”

### 当前事实

当前 `remote_ssh` 路径并没有真正的 session continuation。

实现上仍然是每条消息都重新起一个远端命令：

- Claude:
  - `claude "$PROMPT" --print --permission-mode bypassPermissions`
- Codex:
  - `codex exec --json --skip-git-repo-check -`

见：

- [ssh-executor.ts](/data1/code/agent-platform-v2/src/lib/remote-harness/ssh-executor.ts)

因此当前 continuity 的来源仅仅是：

- 把 recent transcript 拼进 prompt

而不是：

- 延续同一个 remote thread / session / TTY / run context

### 当前模型的含义

现在的 remote 行为其实是：

1. 房间侧保留 transcript
2. 每来一条消息，拼一个新 prompt
3. 远端起一个新的 claude/codex 进程
4. 进程结束后，session 只在 room DB 里留痕
5. 远端 agent 本身没有真正“活着继续聊”

所以：

- **这不是 remote session continuation**
- 只是 **prompt-based replay**

### 这会带来的问题

#### 1. 上下文连续性不稳定

因为 continuity 完全依赖 transcript prompt：

- 长上下文可能被截断
- 某些隐式状态不会保留
- 远端 agent 无法自然延续“上一轮正在做的事”

#### 2. interrupt/continue 语义不完整

现在“中断”只是杀掉这一轮进程。

但如果下一步想支持：

- continue session
- append message to active remote thread
- ask remote agent to resume prior state

当前 fresh spawn 模型支撑不了。

#### 3. latency 与资源成本更高

每轮都要：

- ssh 建连
- remote shell 启动
- harness 命令启动

这比真正的持久 remote session 明显更重。

#### 4. 无法形成和 local codex 类似的统一语义

本地 codex 已经有相对明确的 thread resume 路径，
而 remote 仍然是 one-shot exec。

这会让后续 ACPX bridge 很难把：

- local
- remote
- gateway

统一成同一种 continuation / interrupt / status 模型。

## 为什么“真 remote session continuation”现在值得做

用户已经明确指出这一点的重要性，而且这是合理的。

原因不是“现在完全不能用”，而是：

1. Phase 1 解决的是失控与可观测性
2. 但真正的协作体验仍受制于“一轮一进程”
3. 如果现在不转向 persistent remote session，后续所有 interrupt / continue / handoff 都只能继续打补丁

所以它已经不只是一个 nice-to-have。
它直接关系到：

- Live Room 的连续协作体验
- ACPX 统一执行层的可实现性

## 推荐下一阶段目标

### Phase 1.5

先补 interrupt normalization：

1. room-visible interrupt 文案标准化
2. queued cancel 文案标准化
3. 过滤 known-host warning 等 SSH 噪音
4. 把 interrupt 后的 delivery/session 状态与 system message 统一

### Phase 2

开始设计 true remote session continuation：

目标不是继续做“每轮 fresh spawn + transcript replay”，
而是明确下面其中一种可持续模型：

#### 方案 A. 远端常驻 harness session

例如在 remote host 上维护一个持久 agent process，
`Live Room` / ACPX 通过 append message 与 control signal 跟它交互。

优点：

- 连续性最好
- interrupt / continue / status 最自然

难点：

- 需要 remote side session manager
- 需要可靠的 session lifecycle / reconnect / cleanup

#### 方案 B. 远端 harness 原生 thread/session resume

如果 remote codex / claude CLI 本身支持可恢复 thread，
则应优先复用原生 thread id / session id。

优点：

- 比自建常驻进程简单
- 更接近 local codex resume 语义

难点：

- Claude remote 是否具备成熟 resume 机制还需要验证
- Codex remote thread resume 的稳定性也要评估

#### 方案 C. ACPX remote session bridge

让 `Live Room` 不再自己调 `executeRemoteSshTask(...)`，
而是把 remote member 映射成 ACPX participant，
由 ACPX 维护 session/run/control/event。

优点：

- 路线最统一
- 与 long-term architecture 一致

难点：

- 工程量更大
- 需要先定义 room message 和 ACPX participant session 的映射关系

## 当前最推荐的顺序

建议下一位 agent 按这个顺序做：

1. 先修 interrupt normalization
2. 再确认 remote codex / claude 是否已有可用的 session resume 能力
3. 如果原生能力不够，再决定是自建 remote session manager，还是直接推进 ACPX bridge

## 一句话结论

Phase 1 已经把 `remote_ssh` 从“容易失控的直调”拉回到“可控队列”。

但下一阶段真正决定体验上限的，不再是 queue 本身，
而是：

- **interrupt 是否被正确表达**
- **remote 是否拥有真正的 session continuation，而不是每轮 fresh spawn**
