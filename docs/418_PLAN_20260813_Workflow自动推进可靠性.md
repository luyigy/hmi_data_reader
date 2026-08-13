---
doc_type: PLAN
doc_status: ready
next_action: start_first_slice
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · Workflow 自动推进可靠性

> 本 PLAN 是总设计稿 `docs/408_PLAN_20260812_三Harness进度流精准解析脱敏去重完整展示.md`
> 的 **B 组（Workflow 自动推进可靠性）** 拆出的独立可执行计划。408 作为四组（A 进度流 /
> B watcher 可靠性 / C 文档契约 / D 权限与会话）的总纲保留为评审稿；C 组为
> `docs/409_PLAN_20260812_工作流文档契约闭环.md`、D 组为
> `docs/413_PLAN_20260813_工作流执行权限与会话连续性.md`、A 组为
> `docs/417_PLAN_20260813_三Harness进度流精准解析脱敏去重完整展示.md`。
>
> **slice 映射**：本 PLAN 的 S01/S02/S03 对应 408 设计稿 B 组的 B01/B02/B03（合同 `slice_pattern`
> 要求 `S[0-9]{2,}` 前缀，落地时统一改名，与 C/D 组同法）。

## 背景与根因（事后自愈）

科学试模项目出现“039 HANDOVER 已提交但 S03 没启动、Kimi 反而重跑了 S02”。经核验源码，
确认为**两个连续竞态**，并非“正常停止”：

1. **旧 pending 在房间空闲后被重投**（`src/lib/scheduled-jobs/workflow-watcher.ts`）
   - `if (previous.pending)` 分支（`:371`）会先处理旧 pending；房间忙时返回
     `gate=waiting_previous_completion`（`:577`）且 `cursor: previous` 不变。
   - **关键缺陷**：候选扫描（`:590` 的 `git diff scanFrom head`）只在“无 pending”分支执行 →
     只要 038 的 pending 还卡着，后提交的 039 对 watcher **完全不可见**。
   - 房间一空，watcher 投递的是 038（S02），而不是 039（S03） → Kimi 重跑 S02，S03 从未启动。

2. **提交门禁拦不住同编号并发提交**（`.git/hooks/reference-transaction` +
   `src/lib/scheduled-jobs/workflow-validator.ts`）
   - 钩子用 `git diff --name-only $old $new` 只看**本次提交**改动的文件；两个执行者各自提交一份
     039 时，第二个提交的钩子看不到兄弟提交里的那份 039。
   - `workflow-validator.ts:537` 只校验编号**位数**（width），**不做唯一性检查**；
     唯一性只在 watcher 运行时（`workflow-watcher.ts:608`）查，那时两份都已落地，为时已晚。

3. **隔离后权威文档不会自动复评**（`workflow-watcher.ts:642-655`）
   - 同一 blob 第二次校验失败即 `quarantined=true` 并把游标前移跳过；注释写明“重新提交产生新 blob
     才会复验”。
   - 把冲突副本改名成 040（终态）后，权威 039 没有新 blob → 游标已越过它 → `candidate=none`。
   - 当前只能靠人工对 039 追加说明造一个新提交来触发复评。

**架构确认（@antigravity 复核，见 408）**：

- S01（对应 B01）超越检查放在 **watcher 入口（`if (previous.pending)` 顶层）判定并清空 pending**
  最稳，不引入 `supersededBy` 幽灵字段。
- S02（对应 B02）全树编号唯一校验用 `git ls-tree -r --name-only $new -- <watchRoot>`（只读 tree 对象），
  开销 < 5ms，不拖慢大仓提交。
- S03（对应 B03）隔离文档在待选队列为空时，用当前 head 对应路径重验一次。

**B 组非目标**：不回拨 watcher 游标；不改 completion gate 的成功/失败判定；不改角色编排顺序；
不改 append-only 历史保护（恢复一律以“新增提交”方式进行，不 amend/rebase/reset/强推）。

---

## S01：Watcher 入口的 pending 超越检查（对应 408 B01）

**范围**（`src/lib/scheduled-jobs/workflow-watcher.ts`）

- 进入 `if (previous.pending)` 分支顶层（`:371`）后，先执行一次候选超越检查：用
  `git diff --name-only previous.commit head -- <watchRoot>` 扫描，判定是否存在**编号更大**的
  有效 HANDOVER/PLAN。
- 若存在更高编号文档：输出
  `summary: head=${head} pending_superseded=${previous.pending.path} by=${newerCandidate.filePath}`，
  **清空** `cursor.pending`（置 undefined），**fall-through** 进入下方正常候选扫描流程
  （立即处理 039/S03），不再投递旧 S02。
- 不引入 `pending.supersededBy` 等冗余字段，避免幽灵状态/分支死锁。
- `tests/workflow-watcher.test.ts` 增补：pending=038 且 039 已提交时，watcher 不再投递 038，
  改选 039 并推进；并覆盖 `mode='shadow'` 不改变 cursor 的幂等性。

**完成标准**

- 旧 pending 被更高编号文档超越时立即让位，不再重投旧 Slice；
- `tsc --noEmit`、`test:workflow-watcher`、长文件守卫（`workflow-watcher.ts` 已较大，注意抽函数不越
  800 行预警线）、`git diff --check` 通过。

---

## S02：提交门禁做分支级编号唯一性校验（对应 408 B02）

**范围**（`src/lib/scheduled-jobs/workflow-validator.ts` + `.git/hooks/reference-transaction`）

- 在 validator 中新增编号唯一校验：对受保护 ref 的新 commit 执行
  `git ls-tree -r --name-only $new -- <watchRoot>`，从文件名提取编号做 `Set` 碰撞检查。
- 同编号出现两份（含跨目录）即判 `error`：指出现存文档与新增文档路径，拒绝提交。
- 钩子侧无需改动调用方式（已走 `--hook-batch` 调 validator）；validator 抛
  `WorkflowDocumentValidationError` → 钩子按 `WORKFLOW_DOCUMENT_VALIDATION_FAILED` 拒绝。
- 性能：仅当本次提交改动了 `*_PLAN_*.md` / `*_HANDOVER_*.md` 才触发；tree 遍历只读对象、毫秒级，
  对大仓无影响。
- `tests/workflow-validator.test.ts` 增补：ref 已有 039 时再交第二份 039（含跨分支目录）被拒并报
  出现存路径；不同编号放行。

**完成标准**

- 同编号并发提交在落地时即被拦截，不再依赖 watcher 运行时才发现；
- validator 运行时崩溃仍按现状降级为告警（不冻结提交）；`tsc --noEmit`、相关测试、`git diff --check` 通过。

---

## S03：隔离区文档自动复评（对应 408 B03）

**范围**（`src/lib/scheduled-jobs/workflow-watcher.ts`）

- 当 `previous.validationFailure?.quarantined` 存在、且本轮候选扫描待选队列为空时，用当前 `head`
  对应路径对该隔离文档重验一次。
- 若冲突已解除（例如同号竞争文档被改名/终态化），清空 `validationFailure` 并将该权威文档重新选为
  candidate 推进，**无需人工造无意义 commit**。
- 若仍失败，保持隔离、记录本轮已复评，避免每次空跑告警刷屏（复评节流）。
- `tests/workflow-watcher.test.ts` 增补：039 隔离后改名产生 040 终态，watcher 下次扫描自动复验
  039 并推进；隔离未解除时不重复告警。

**完成标准**

- 冲突解除后权威文档自动复评推进，消除“只能人工补 commit”的运维负担；
- 复评有节流，不刷屏；`tsc --noEmit`、`test:workflow-watcher`、`git diff --check` 通过。

---

## 落地顺序与安全守卫

- B 组内部 S01（pending 超越）→ S02（提交门禁唯一性）→ S03（隔离复评）串行；三者均只碰
  `workflow-watcher.ts` / `workflow-validator.ts` / `.git/hooks`，文件集与 A/C/D 组不重叠，可并行。
- **watcher 安全**：S01 超越检查只在“存在编号更大的有效文档”时清空 pending，避免误清正常等待审批的
  pending；S02 的全树校验只拦同编号碰撞，不影响合法重命名/移动；S03 复评有节流，隔离未解除不刷屏。
  任何 watcher 恢复都不回拨游标（append-only 历史，回拨有风险）。
- **长文件守卫**：`workflow-watcher.ts` 已较大，新增职责必须先抽函数再使用，绝不越 1000 行阻断线；
  开工前跑 `npm run check:long-files`。
- **Git 历史**：本仓库工作流历史只追加；本 PLAN 落地期间不 amend/rebase/reset/强推。
- **运维口径**：B 组所有恢复一律以“新增提交”方式进行；S03 落地前的临时处置（对权威文档追加说明造
  新提交触发复评）在 S03 上线后可移除。


<!-- WORKFLOW_PROMPT_START -->
执行 `docs/418_PLAN_20260813_Workflow自动推进可靠性.md` 的 S01；读取目标 HEAD 的 `AGENTS.md`、
`docs/workflow/workflow-contract.yaml` 和本 PLAN。完成验证、创建下一 HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
