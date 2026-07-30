---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: null
slice: workflow-monitoring-registry
plan_progress: complete
---

# HANDOVER · Workflow 监控项目登记与 HMI 接入

## 文档定位

本文记录 Agent Platform workflow watcher 已纳管项目，并交接 HMI Reader 的接入结果。
项目配置的唯一事实源是 `config/projects.yaml`；下表是便于运维和交接的快照，不替代配置。

## 已纳管项目

截至 2026-07-30，平台配置了 4 个 workflow watcher：

| 项目 ID | 仓库 / Git ref | 飞书目标 | 模式 | 初始游标 |
|---|---|---|---|---|
| `agent-platform-v2` | `/data1/code/agent-platform-v2` / `refs/heads/oss-prep` | P2P `oc_b634823504e29e6220de0cfb5108a216` | active | `c8d3ec5b24bc7e0165be31df02397813ff608a95` |
| `mold-data-webpage-tool` | `/data1/code/mold-data-webpage-tool` / `refs/heads/rebuild-postgres-auth-slice` | 群 `oc_b4d2abbe3c16c3596631c3a9e756bd4f` | active | `ebe9182bebcc8ede4691428459e27c3ad292771e` |
| `workflow-test` | `/data1/code/workflow-test` / `refs/heads/workflow-test` | 群 `oc_0684589953a98e6b17a8d148c6b77756` | active | `8157fc60a8067af781db67d8d807e1f9d62ce474` |
| `hmi-data-reader` | `/data1/code/hmi_data_reader` / `refs/heads/master` | 群 `oc_5c8067219168958335bfc59d5fbb2b11` | active | `1a066152a1420f97b3a1cc6517937e48c3451b7e` |

所有 watcher 当前均为每分钟扫描，使用目标仓库
`docs/workflow/workflow-contract.yaml`，并启用 active side effects。

## 本次新增：HMI Reader

### 原因

HMI Reader 的 `007 PLAN` 已提交，但平台没有项目注册项，目标仓库也没有 workflow contract，
因此 scheduled-jobs 不会扫描该仓库；仅提交 PLAN 不能触发 watcher。

### 完成内容

1. 在平台 `config/projects.yaml` 注册 `hmi-data-reader`、目标分支、飞书群和 active
   `workflow-watcher`。
2. 在 HMI 仓库新增 `docs/workflow/workflow-contract.yaml`。
3. 修正 `docs/007_PLAN_20260730_端到端薄切片实施计划.md`：
   - 使用合同要求的 Prompt 标记；
   - Prompt 显式引用 PLAN；
   - 将 Slice 正则放宽为 `S[0-9]+`，兼容该项目的 `S1`–`S4` 编号。
4. 将 `initial_cursor_commit` 设为 PLAN 父提交 `1a066152...`，保证 watcher 能看到已经提交的
   `dee540f`，而不是从 PLAN 之后开始扫描。
5. 重启 `agent-platform-scheduled-jobs.service`，使常驻 runner 重新加载项目配置。

### 提交

| 仓库 | Commit | 内容 |
|---|---|---|
| Agent Platform | `8403fa8f816a677700817a203a0b98e17a0268e5` | 注册 HMI workflow watcher |
| HMI Reader | `0f3a641` | 增加 workflow contract 并修正 PLAN 格式 |
| HMI Reader | `c730a38` | 追加修正 Slice 正则和 PLAN 引用 |

HMI 的两次修正均使用追加提交，没有 amend、rebase 或改写 watcher 可能已经读取的历史。

## 验证结果

- 平台项目配置可正常解析和加载。
- workflow validator 对 HMI `007 PLAN` 校验通过，动作是 `start_first_slice`。
- scheduled-jobs 测试通过。
- GitNexus `detect_changes` 结果为 LOW：配置变更未映射到代码 symbol 或 execution flow。
- scheduled-jobs 服务重启后保持 `active/running`。
- HMI watcher 已识别 `007 PLAN` 并发送审批卡片；本次交接时状态为
  `plan_review`、`card_sent=true`，等待审批后执行 S2。

## 后续新增项目的最小清单

1. 确认目标仓库、目标 Git ref、飞书 chat ID、chat type 和审批人。
2. 确认目标 ref 已提交 `docs/workflow/workflow-contract.yaml`。
3. 校验 PLAN/HANDOVER 的 YAML frontmatter、Slice 规则和 Prompt 标记。
4. 在 `config/projects.yaml` 增加项目和 `workflow-watcher`；不要另建项目台账配置。
5. `initial_cursor_commit` 指向首个待消费工作流文档的父提交，避免跳过该文档。
6. 运行项目配置测试、workflow validator 和长文件守卫。
7. 提交目标仓库与平台仓库变更；watcher 已启用后只追加 Git 历史。
8. 重启 scheduled-jobs 后确认服务状态，并以持久化 Run 或审批卡片确认首次扫描成功。

## 边界与遗留

- HMI 工作区原有的 `docs/000_INDEX.md` 修改和未跟踪 `006 REPORT` 未纳入本次提交。
- 本次只接入工作流监控，没有修改 HMI 业务代码。
- 新项目清单发生变化时，应以 `config/projects.yaml` 为准更新本文的“已纳管项目”快照。
