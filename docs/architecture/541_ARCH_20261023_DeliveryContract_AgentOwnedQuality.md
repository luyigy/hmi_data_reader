# Task Graph Delivery Contract 与 Agent-owned Quality 架构收敛方案

**文档类型：** ARCH  
**基准版本：** `oss-prep`，参考 Commit `bdb462b`  
**改造范围：** Task Graph 交付协议、质量责任与状态流转  
**实施原则：** 架构收敛、最小改动、保留现有安全机制

> **重要：** 本文中的源码行号对应参考 Commit。实施前必须核对最新 HEAD、仓库 `AGENTS.md` 和实际调用链。文中目标代码是设计意图，不可不经审查直接替换。

---

## 1. 背景：我们究竟要解决什么？

我们的 Agent Platform 目标是：

**一个获批 Ticket，就是一个可以持续自主工作的 Coding Agent 任务。**

Matt Pocock 的 Grill / Spec / Tickets 用于实施前对齐任务；pstack 的 Investigator / Architect / Implementor / Tester 及相关 Skills 用于帮助 Agent 正确开展工程工作。

Task Graph 负责调度 Ticket，Git Worktree 和 Sandbox 负责隔离工作环境，平台负责保证安全交付。

当前平台存在两类职责混杂。

### 问题 A：`collect_result` 过度工作流化

Agent 已经完成一轮编码，但结构化回执格式错误，例如：

```text
TASK_GRAPH_IMPLEMENTATION {
  "status": "blocked",
  "note": "..."
}
```

缺少 `blockerKind`。

这实际上只是 Agent 的输出协议错误，不代表工程实施失败。

当前代码通过 `result_incomplete`、`collect_result`、重试次数等机制处理。

虽然已进行改进，但我们不希望继续围绕格式错误建立特殊恢复工作流。

**目标：** 格式错误直接反馈原 Native Session，由原 Agent 正常继续工作。Agent 可以只修正回执，也可以继续修改代码或测试。

### 问题 B：平台与 Agent 重复承担工程质量判断

当前 `coordinator.ts` 在 Git Integration 期间可能调用：

```typescript
checks = await runChecks(
  implementOnly ? [] : config.checks,
  staging,
  { ...inputs.env, AP_GRAPH_SERVICE_TASK_ID: task.id, AP_GRAPH_WRITER_NONCE: worker.nonce },
  inputs.readOnlyPaths
);
```

随后可能还有独立 Reviewer / Tester 的验证过程。

因此，工程质量可能同时由 Implementor、平台预设检查和 Reviewer 裁决。

**目标：** 每个 Ticket 在批准时明确质量责任归属。

- 只有 Implementor：由 Implementor 按批准的验收标准自查并提供证据。
- 配置 Tester：由 Tester 针对固定候选独立验证。
- 配置 Human Review：保留已批准的人工审批。
- 平台：只负责检查交付身份、权限、证据完整性、代码版本一致性和状态安全。

注意：**这不意味着废除测试，也不意味着可以绕过已批准的验收条件。**

---

## 2. 目标架构

### 2.1 职责边界

| 组件 | 应当负责 | 不应负责 |
|---|---|---|
| Matt Skills | 需求澄清、Spec、Tickets、验收要求 | Runtime 调度 |
| Implementor | 调查、编码、测试、修复、自查、声明交付 | Git 集成分支的受控更新 |
| Tester（如配置） | 独立执行验证、提供缺陷反馈、判定工程质量 | 修改 Implementor 正在写入的 Worktree |
| Coordinator | 调度 Agent、交付衔接、状态推进 | 自行创造额外业务质量标准 |
| Store | 校验合法责任人、交付证据、固定 Commit 并持久化结论 | 重新解释或覆盖责任 Agent 的工程判断 |
| Git / Sandbox | Writer 隔离、权限控制、Commit 身份、CAS | 判断业务功能是否满足需求 |

### 2.2 两项核心原则

**原则一：Agent 拥有工程行为自主权。**

格式错误、测试失败、修复建议都应回到原 Agent 工作会话。不因平台处于 `collect_result` 就强制只读或禁止修改源码。

**原则二：平台拥有交付一致性的最终保障责任。**

不能用旧 Commit 的验证结论批准新代码；不能由错误的 Agent 提交验收结论；不能绕过已批准的权限、人工审批和真实前置依赖。

---

## 3. Delivery Sequence：以一个真实 Ticket 为例

假设 M6_YIZUMI 的 Implementor 正在开发 HMI 识别功能。

### 第一步：Implementor 实施

Agent 在自己的 Worktree 调查问题、修改代码、运行测试。

它可能进行多轮对话和修复。

这些都是正常的 `implement` 工作，不意味着 Ticket 已完成。

### 第二步：Agent 宣布交付

Agent 明确返回合法的 `delivered`，附带测试证据和交付说明。

如果回执格式错误：

- 平台反馈具体错误。
- 继续原 Session。
- 保持正常 Implementor 权限。
- 相同候选、输入和错误连续重复时采用已有防空转限制。
- 有实质工作进展不能被历史格式错误次数阻止。

### 第三步：固定 Candidate

Agent 本轮 Writer 退出后，平台固定当前 Worktree 的最终 Candidate Commit。

必须保证交付声明对应当前源码，而不是上一次格式错误时保存的旧 Candidate。

### 第四步：Git Integration

平台使用现有 Git Integration Ref、Claim/Revision、Writer Ownership 和 CAS。

如果发生 Git 冲突，交由有权限的 Agent 解决。

**Git 集成安全与工程测试质量必须分开理解。**

### 第五步：工程质量验证

**模式 A：仅 Implementor**

Implementor 对批准的验收要求负责，提交自查结果和证据。

平台检查证据是否属于正确执行及固定代码版本，不增加另一个隐藏的业务质检过程。

**模式 B：Implementor + Tester**

Tester 获取 Spec、Ticket、固定代码版本和已有证据，独立验证并给出结论。

不通过时，缺陷反馈给原 Implementor。修改后的新 Candidate 需要重新集成和验证。

**模式 C：Human Review**

保留已批准的人工审批，不能通过 Agent 自查替代用户的批准动作。

### 第六步：完成与接棒

平台确认合法交付及验收条件满足，持久化 Node 完成事件。

只有满足已批准依赖条件的后继 Ticket 才能释放。

---

## 4. 状态机：优先复用现有状态

不要创建一套新的 `PENDING / WORKING / INTEGRATING / VERIFYING / DONE` 数据库枚举。

现有结构已经具备：

| 层级 | 现有字段 | 职责 |
|---|---|---|
| TaskGraphNode | `status` | Ticket 整体状态 |
| TaskGraphExecution | `status` | 仓库级执行状态 |
| ExecutionProgress | `phase` | 当前执行阶段 |
| ExecutionProgress | `state` | 活动、等待及异常控制状态 |

目标逻辑路径：

```text
Node planned / ready
       ↓
Execution claimed
       ↓
Progress implement
       │
       ├── working → implement
       ├── 回执格式错误 → 原 Agent 继续 implement
       ├── waiting_for_user → 等待用户，回复后继续
       └── delivered
                 ↓
         固定 Candidate
                 ↓
         Progress integrate
                 ↓
         Execution integrated
                 ↓
         责任 Agent 验证
                 │
                 ├── 不通过 → Implementor 修复
                 │
                 ├── 人工审批 → awaiting_human
                 └── 通过 → Node passed
                                  ↓
                           释放后继 Ticket
```

### 特别需要审查

目前 `domain.ts` 的 `isCompletedNodeStatus()` 将 `passed` 和 `delivered_unverified` 都视为完成状态。

必须明确：

**`delivered_unverified` 不能自动被解释成已完成 Implementor 自查。**

现有 `implement` 模式及历史 Ticket 需要兼容策略，不得在迁移时悄悄更改已批准的完成条件。

---

## 5. 精确源码改造范围

### 5.1 `implementation-result.ts`

**职责：** 识别 Agent 的普通工作反馈与明确交付声明。

要求：

- 保留严格的交付字段校验。
- 返回具体、可理解的格式错误。
- 格式错误由原 Agent 处理，不扩大为新业务失败。
- 不新增特殊恢复管理器。

### 5.2 `coordinator.ts`：Candidate 和结果反馈

参考位置：第 576–603 行。

需要确认：

- `commitJobWorktree()` 的 Candidate 是工作快照还是正式交付。
- 最终 `delivered` 是否与当前最终 Commit 正确绑定。
- `result_incomplete` 是否复用原 Native Session。
- 是否存在只读限制、重复派发或无进展空转。

目标是简化正常实施路径，而不是机械删除所有 checkpoint。

### 5.3 `coordinator.ts`：Git Integration 与 `runChecks`

参考位置：第 612–634、670–686 行。

当前关键逻辑：

```typescript
verify: async (staging) => { // Git 集成过程中执行的回调
  await outcome({ // 记录当前执行进度
    kind: 'checkpoint', // 表示保存代码快照
    phase: 'integrate', // 当前处于集成阶段
    candidateCommit: await graphGit(staging, 'rev-parse', 'HEAD') // 获取暂存目录当前 Commit
  }); // 完成进度记录
  checks = await runChecks(implementOnly ? [] : config.checks, staging, { ...inputs.env, AP_GRAPH_SERVICE_TASK_ID: task.id, AP_GRAPH_WRITER_NONCE: worker.nonce }, inputs.readOnlyPaths); // 在集成时执行预设工程检查
}, // 回调结束
```

**架构目标：**

将默认业务质量执行与 Git Integration 解耦。

但是，不允许简单删除 `runChecks()` 就宣称改造完成。

必须先确认：

1. 哪些检查是已批准的硬条件。
2. 哪些检查属于 Implementor 自查。
3. 哪些检查属于 Tester 独立验证。
4. 哪些检查属于平台必须执行的安全/完整性校验。
5. 原先测试失败的反馈如何继续交给原 Implementor。

能复用现有 Check Runner 就复用，不为迁移增加另一套测试编排系统。

### 5.4 `domain.ts`

参考位置：`executionMode`、`acceptance`、`isCompletedNodeStatus()`。

需要明确 `full / lean / implement` 与质量责任配置的关系。

优先复用现有合同字段，避免建立平行的 `verificationMode` 状态系统。

如果旧字段无法表达新语义，应先说明最小合同变更和兼容迁移方式。

### 5.5 `store.ts`

参考位置：`submitNodeVerification()`，约第 292–335 行。

当前代码检查提交证据与 `checks`，并计算 `allPassed`。

改造不能删除以下安全保障：

- 验证者身份正确。
- 结论对应已批准 Ticket。
- 结论绑定正确的 Integrated Commit。
- 必需验收证据存在。
- 人工审批仍需用户确认。
- 完成事件幂等。
- 失败不能释放后继。

应明确区分：

**责任 Agent 判断工程质量；平台验证这份结论是否有资格成为正式完成记录。**

同时检查现有 `assertGraphReviewOwnershipTx()`、Reviewer 投递路径和状态更新机制，避免绕过原有所有权保护。

---

## 6. 不要修改的承重墙

以下能力必须保留：

- 单 Worktree Writer Ownership。
- TaskRun 实际退出证明。
- Claim Token / Revision。
- Git Integration CAS。
- W001 阶段一致性约束。
- Sandbox 和批准权限。
- Session Resume。
- 幂等事件记录。
- 用户明确批准的人工审批和验收要求。
- 真实前置依赖。
- 正在运行的业务 TaskRun 与其已批准合同。

**不能为了消除质量裁判重复问题，直接跳过已有失败的生产测试。**

已有运行中的 Reader/Mold Ticket 应继续沿旧合同执行；新语义应在明确兼容边界后应用到后续批准的 Ticket。

---

## 7. 实施切片

### S01：Thin Delivery Handoff

目标：让实施交付更接近普通 Coding Agent 的持续会话。

验收：

- 普通回复继续工作。
- 格式错误反馈原 Agent。
- Agent 允许继续编码和测试。
- 最终 Candidate 与 delivered 声明一致。
- 不产生新的恢复状态机。
- 重复无进展错误不会无限空转。

### S02：Agent-owned Quality

目标：消除平台与责任 Agent 的重复业务质量判断。

验收：

- Implementor-only 模式能提供合法自查证据并完成。
- Implementor + Tester 模式由 Tester 独立验证。
- 验证失败返回原 Implementor。
- 修复后新 Commit 必须重新验证。
- Human Review 正常保留。
- 已批准强制检查没有丢失。
- Node 完成与后继释放正确。
- Git/Sandbox/Writer 等安全机制不受影响。

建议分别提交独立 Commit，避免把格式纠错与质量责任迁移混成一个巨大改动。

---

## 8. Coding Agent 的具体工作要求

**第一步：审查当前代码。**

阅读最新源码，画出现有 Delivery Sequence，标明各状态转换真正发生在哪个函数、哪一行。

**第二步：形成精确 Before / After。**

对每个修改点提供：

- 当前文件及真实行号。
- 当前源码逐行中文注释。
- 目标修改代码逐行中文注释。
- 哪些行删除、保留、迁移。
- 为什么这样改。
- 修改后的状态流转和风险。

不要用虚构 helper 函数代替实际修改方案。如果展示伪代码，必须明确标注。

**第三步：先写红色回归。**

至少覆盖：

- 回执格式错误及正常续接。
- 继续编码后 Candidate 更新。
- Implementor 自查。
- Tester 独立验证。
- 失败反馈与再次验证。
- Human Review。
- 集成冲突和 CAS。
- `delivered_unverified` 兼容。
- 后继依赖释放。

**第四步：最小实现并运行绿色回归。**

优先删除重复的业务决策，保留现有基础设施。

不引入新的 Coordinator、Recovery Manager、状态机、重复合同或角色。

**第五步：提交交付报告。**

明确报告：

1. 删除了哪些重复逻辑。
2. 哪些职责转移到 Implementor / Tester。
3. 哪些平台安全检查仍然存在。
4. 每种 Ticket 模式如何完成。
5. 新旧行为的兼容边界。
6. 测试结果及 Commit SHA。

---

## 9. 最终验收原则

架构收敛成功，不是看删除了多少代码，而是看下面四句话是否同时成立：

**第一：** Agent 能在同一 Ticket、原 Session 中自然开展工程工作。

**第二：** 每个 Ticket 的工程质量只有明确且获批准的责任归属，不存在隐藏的第二套业务裁判。

**第三：** 平台仍能严格保证代码版本、权限、Writer、证据与状态的一致性。

**第四：** Ticket 完成后，Task Graph 能根据真实完成事件可靠地接续后继任务。

> **最终架构原则：Matt 定义要做什么及验收要求；Implementor / Tester 负责工程质量；Task Graph 负责调度；平台保证交付安全与一致性。**