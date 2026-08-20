---
doc_type: ISSUE
doc_status: draft
next_action: none
---

# ISSUE · 并行 Slice 执行引擎落地 TODO：Worktree 隔离、范围守卫与 Fan-in 合并（含 implementer 评审校准）

## 状态与优先级

- **优先级**：P1（多 Agent 并发效率与工作区安全的核心能力，承接已有议题进入落地阶段）。
- **状态**：draft，记录于 Git Inbox，供后续 Workflow 排期拆解为正式 PLAN。
- **提出时间**：2026-08-20（Live Room「Feishu DM 08a216」多 Agent 讨论综合，implementer 评审）。
- **关联议题**：
  - [351_ISSUE_20260801_并行工作流调度与GitWorktree任务隔离执行.md](351_ISSUE_20260801_并行工作流调度与GitWorktree任务隔离执行.md)（Worktree 隔离原始诉求）
  - [391_ISSUE_20260809_双工作模式演进_GitWorktree并行工作树与角色分工串行流水线及平滑切换.md](391_ISSUE_20260809_双工作模式演进_GitWorktree并行工作树与角色分工串行流水线及平滑切换.md)（双模式顶层架构、Merge Queue 与自愈闭环）
  - [378_ROADMAP_20260804_Inbox议题优先级排期与实施规划.md](378_ROADMAP_20260804_Inbox议题优先级排期与实施规划.md)（排期总览）
  - [382_ISSUE_20260804_Agent职责分工与按意图路由.md](382_ISSUE_20260804_Agent职责分工与按意图路由.md)（角色路由，串行侧对应物）

## 背景与定位

2026-08-20 Live Room 讨论中，已形成一份较完整的并行执行方案：`parallel_phase` PLAN（slices 含 `allowed_paths` / `depends_on` / `assignee`）、Git Worktree 物理沙箱、静态重叠预警 + 完成门禁双层守卫、集成分支渐进合并（Fan-in）、Live Room 多轨状态卡片，并给出三阶段演进节奏。

351 / 391 已承载该方向的**架构设计**；本文件定位为**落地 TODO + implementer 意见**，把讨论方案按代码现状校准成可执行清单，避免后续 PLAN 低估工作量或走错顺序。

## Implementer 评审结论（综合看法）

### 认同的部分

1. **Worktree 是正确的隔离原语**：Git 原生、共享对象库、磁盘开销低，优于复制仓库或容器级隔离。
2. **“静态预警 + 完成门禁硬拦截”双防线正确**：且硬拦截的扩展点已经存在——`workflow-completion-gate.ts` 已在计算 changed files（`git diff --name-only`），补 per-slice `allowed_paths` 匹配即可复用现有纠错循环。
3. **集成分支 + 渐进合并的 Fan-in 拓扑正确**，比 N 方向直接 merge 主分支安全。
4. **分阶段演进（2 slice MVP → 自动化 → DAG/多机）节奏正确**，但阶段内容需要重新切分（见下）。

### 需要校准的部分（与讨论方案的差异）

1. **`src/lib/git-worktree.ts` 是零引用脚手架**：全仓无任何 import（仅 351+350 S05 提交过一次工具库）。所谓“扩展”实际是**从零接线**：现接口只按 taskId 建时间戳分支，无集成分支管理、无生命周期注册表、无清理编排，MVP 工作量按新落地评估。
2. **文档契约层缺口比想象大，必须先行**：`workflow-contract.yaml` 的 plan kinds 只有 `phase` / `interrupt`，`parallel_phase` 会被 validator 直接判 `PLAN_KIND_INVALID`；slice 目前只有编号 pattern，没有 `assignee` / `depends_on` / `allowed_paths` 语义。契约 v3 需要同步改 contract、`workflow-validator.ts`、`workflow:new` / `workflow:validate` 脚本、模板与 completion gate，**这是整条链路里最大的隐性工作量，且不改完它，任何并行 PLAN 都过不了现有门禁**。
3. **并行度建模在调度层，不在 runner 内**：`executeAcpxTaskRun` 的 participants 是单 run 内串行 for 循环、共享一个 `workingDirectory`。不要重构这个循环；正确做法是**调度器为每个 slice 派发独立 TaskRun，各自 `workingDirectory` 指向专属 worktree**，fan-out/fan-in 由调度器编排。
4. **MVP 砍掉/降级以下项**：
   - `node_modules` 软链共享：`.bin` 链接、postinstall、next 缓存绝对路径、原生模块都会踩坑，且可能反向写坏主仓依赖；MVP 每 worktree 独立安装（可先 `--omit=dev`），共享优化后置。
   - 冲突自动唤起 Agent rebase 自愈：MVP 降级为“冲突 → Live Room 通知 + 人工决策”；自愈闭环与 391 的 Phase 4 对齐后置。
   - 跨 Gateway（如 TX-server）worktree：worktree 必须建在执行节点本地的 clone 上，涉及远端 BranchSpace 同步；MVP 限定同一执行后端（platform_local）内并行，跨机后置。
5. **讨论方案完全遗漏的坑（必须进 TODO）**：
   - **并发文档编号冲突**：PLAN/HANDOVER 编号 branch_space 内唯一，N 个 slice 并发 commit 工作流文档必然撞号；需要任务级集中发号或集成分支统一补号。
   - **Watcher 单游标假设被打破**：watcher 只读目标 Git ref 已提交文档、按单链 cursor 推进；并行分支必须先在集成分支归并 HANDOVER/PLAN 再恢复 watcher，否则断链。
   - **并行自测的资源踩踏**：next dev 端口、prisma generate、测试 DB 会在多 worktree 并发时互踩；MVP 要求自测错峰或端口分配表。
   - **长文件守卫需进 worktree**：`large_files` 契约（800 告警 / 1000 阻断）应在各 slice gate 内独立执行，防止并行 Agent 各自膨胀共享文件。
   - **越界修改的纠错上限**：completion gate 纠错循环最多 2 次；越界回滚类错误需要更明确的 abort 语义，避免循环空转。

## 落地 TODO 清单

### P0 · 文档契约层先行（不涉及 Worktree，串行模式即受益）

- [ ] T0.1 契约 v3：`docs/workflow/workflow-contract.yaml` 新增 `plan_kind: parallel_phase` 与 slices 结构化字段（`allowed_paths` / `depends_on` / `assignee`），保持向后兼容（旧 `phase` 不受影响）。
- [ ] T0.2 validator 支持：`src/lib/scheduled-jobs/workflow-validator.ts` 解析并校验新字段（kinds 合法性、`allowed_paths` glob 语法、`depends_on` 引用存在性、DAG 无环）。
- [ ] T0.3 静态重叠检查器：PLAN 校验阶段对并行 slice 的 `allowed_paths` 做 glob 交叉检测，重叠即阻断并提示提取为前置依赖 slice。
- [ ] T0.4 完成门禁范围校验：扩展 `src/lib/acpx/workflow-completion-gate.ts`，按 `git diff --name-only <base>` 与 `allowed_paths` 匹配，越界即阻断（复用现有 changed-files 计算与纠错循环，明确 2 次失败后的 abort 语义）。
- [ ] T0.5 模板与脚本：`docs/workflow/templates/PLAN.md`、`npm run workflow:new` / `workflow:validate` 适配新 frontmatter 与 parallel 字段。

### P1 · Worktree 运行时 MVP（2 个无重叠 slice，同后端）

- [ ] T1.1 Worktree 生命周期管理：激活 `src/lib/git-worktree.ts` 并补齐——集成分支 `task/<taskId>-integration` 创建/回收、slice 分支 `task/<taskId>-<sliceId>`、清理注册表（防孤儿 worktree/分支）。
- [ ] T1.2 调度器 fan-out：为每个并行 slice 派发独立 TaskRun，`executeAcpxTaskRun` 的 `workingDirectory` 指向 `.worktrees/<taskId>_<sliceId>/`；不重构 runner 内部串行循环。
- [ ] T1.3 各 worktree 内独立跑长文件守卫与 slice 自测（含端口/资源错峰策略）。
- [ ] T1.4 Fan-in：slice 完成并通过 scope gate 后按完成顺序 merge 进集成分支；冲突时通知 Live Room 并暂停等待人工决策；全部合并后触发 Reviewer/Tester 在集成分支全量验收，再合回工作分支。
- [ ] T1.5 工作流文档归并：并发 HANDOVER/PLAN 的集中发号与集成分支归并，恢复 watcher 单游标语义。

### P2 · 自动化与体验

- [ ] T2.1 `depends_on` DAG 自动触发：依赖 slice 全部合并后自动唤醒下游（复用工作流完成事件即时唤醒链路）。
- [ ] T2.2 合并队列与冲突自动协调（可辨识冲突自动唤起 assignee rebase，复杂冲突升级人工）。
- [ ] T2.3 Live Room / 飞书多轨状态卡片：主线概览 + 各 slice 阶段性广播，收敛详细日志到 slice 独立上下文。
- [ ] T2.4 依赖共享优化（node_modules/缓存策略）与 worktree 磁盘配额、GC。

### P3 · 分布式与自愈

- [ ] T3.1 跨 Gateway / 远端节点的 worktree 派生（远端 clone 上建树 + BranchSpace 同步）。
- [ ] T3.2 冲突与测试失败的 Agent 自愈重入队闭环（对齐 391 Phase 4）。

## 验收标准

1. P0 完成后：`parallel_phase` PLAN 可通过 `workflow:validate`；任一 PLAN（含串行）完成时，越界 `allowed_paths` 的修改被 completion gate 阻断并给出明确文件清单。
2. P1 完成后：`/run parallel`（或等价入口）可将 2 个无重叠目录的 slice 并行派发给 2 个 Agent，各自在独立 worktree 执行，无工作区互踩；按序合并进集成分支，全程无人工干预除非发生合并冲突；结束无残留 worktree/分支。
3. P2/P3 完成后：依赖 slice 合并自动触发下游；多轨卡片可见各 slice 进度；跨后端并行可用且冲突可自愈。

## 风险与守卫

- 契约 v3 改动波及 contract / validator / templates / gate / 脚本五处，须一次性同 PR 落地，避免中间态文档被 watcher 消费。
- 并行模式全程保持 Git 历史只追加；集成分支合并不得改写已提交历史。
- Worktree 目录（`.worktrees/`）必须加入 gitignore 与 `ignored_path_parts`，防止被长文件扫描与提交误伤。
