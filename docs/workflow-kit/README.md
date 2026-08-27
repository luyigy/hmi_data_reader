# Workflow Kit（通用工作流套件 · 模板目录）

本目录是可拷贝的工作流套件模板，用于把 agent-platform-v2 监测执行的 PLAN/HANDOVER 文档工作流
接入任意新仓库。所有仓库相关的值都用 `[CHANGE-ME]` 标注（YAML 用 `# [CHANGE-ME]` 注释，
Markdown 用 `<!-- [CHANGE-ME] ... -->` 注释），套用时逐项替换即可。

## 能否直接套用到其他仓库？

**文档套件可以**：把本目录的文件复制到目标仓库的对应位置，替换所有 `[CHANGE-ME]` 即可。
**但复制文件不等于接入完成**：agent-platform-v2 侧的项目注册（`projects.yaml.example` 那一步）
是平台侧配置，每个仓库都要单独做，无法靠拷贝仓库文件替代。

## 目录内容 → 目标仓库位置

| 套件文件 | 复制到目标仓库 | 说明 |
| --- | --- | --- |
| `workflow-contract.yaml` | `docs/workflow/workflow-contract.yaml` | 机器可读合同（平台运行时读取的唯一规则源） |
| `PLAN-writing-standard.md` | `docs/workflow/PLAN-writing-standard.md` | 跨仓 PLAN 写作与 Slice 划分规范（合同 `standards.plan` 引用） |
| `templates/PLAN.md` | `docs/workflow/templates/PLAN.md` | PLAN 骨架（合同 `templates.plan` 引用） |
| `templates/HANDOVER.md` | `docs/workflow/templates/HANDOVER.md` | HANDOVER 骨架（合同 `templates.handover` 引用） |
| `docs-workflow-README.md` | `docs/workflow/README.md` | 工作流目录入口说明（平台注册要点） |
| `docs-workflow-AUTOMATION_GUIDE.md` | `docs/workflow/AUTOMATION_GUIDE.md` | 平台监测执行操作指南 |
| `AGENTS-workflow-section.md` | 并入根 `AGENTS.md` | 工作流守则段落（追加，不是整文件替换） |
| `projects.yaml.example` | 不复制进仓库 | 平台 `config/projects.yaml` 的项目条目示例 |

另需在目标仓库自建：分支文档空间目录（合同 `branch_spaces.root` 指向的目录，
如 `docs/codex/<branch-space>/`）和需求池 `docs/inbox/`（可选，`auto` 模式用）。

## 全部 CHANGE-ME 清单（套用核对表）

### A. `workflow-contract.yaml`

- [ ] `contract_version`：按目标仓库自定版本号（建议 `YYYY.MM.DD.N`）。
- [ ] `documents.allowed_types`：按仓库需要增删（例如加 `DISCUSSION`、`TODO`）。
- [ ] `documents.slice_pattern`：默认用宽松版；要强制"标题行内 Slice 号"改用注释里的严格版。
- [ ] `branch_spaces.root`：分支文档空间根目录（示例 `docs/codex`，也可用 `docs/branches` 等）。
- [ ] `branch_spaces.unnumbered_branches`：本仓库不建编号目录的分支名。
- [ ] `legacy.cutoff_commit`：早于此 commit 的文档豁免校验。取接入时当前 HEAD 的完整 SHA
      （`git rev-parse HEAD`），并用 `git log -1 --format=%ci <SHA>` 在注释里记录时间。
- [ ] `large_files.thresholds`：按仓库实际调整（默认 800 告警 / 1000 阻断）。
- [ ] `large_files.source_extensions`：按技术栈增删（如 `.kt`、`.swift`、`.m`）。
- [ ] `large_files.ignored_path_parts`：按技术栈补充（如 `.next`、`target/`、`.turbo`）。
- [ ] `templates` / `prompt` / `numbering` / `actions` / `statuses` / `completion_gate`：
      建议保持默认（平台已按此契约实现，改动需核对平台 validator 支持）。

### B. `docs-workflow-README.md`

- [ ] 三个 `[CHANGE-ME]`：自动化扫描边界（branch space 目录）、配置 Git ref、
      平台项目 id/自治模式/执行策略。

### C. `docs-workflow-AUTOMATION_GUIDE.md`

- [ ] 开头 `[CHANGE-ME]`：平台部署位置/仓库地址（其余内容仓库无关）。

### D. `AGENTS-workflow-section.md`

- [ ] `[CHANGE-ME]`：本仓库文档目录前缀（`docs/codex` 等）。
- [ ] `[CHANGE-ME]`：仓库内是否有 `workflow:new/validate` npm 脚本；没有则保留
      "用平台命令或模板手写"的分支表述。

### E. 平台注册（`projects.yaml.example`）

- [ ] `id` / `name` / `path`（服务器上绝对路径）/ `ref`（完整 `refs/heads/...`）。
- [ ] `feishu.chat_id`、`approver_open_ids`、`coding_bot_*`（通知与审批通道）。
- [ ] `branch_space`（= 文档空间子目录名，根空间用 `.`）。
- [ ] `initial_cursor_commit`（接入起点 HEAD 的完整 SHA，早于它的提交不扫描）。
- [ ] `workflow_autonomy`（manual / semi_auto / auto）与 `execution_policy.preset`
      （workspace / full_access）。

## 套用步骤

1. 复制文件到上表位置，创建分支文档空间与 `docs/inbox/`；
2. 逐项替换 CHANGE-ME（用本 README 的核对表）；
3. 决定 `legacy.cutoff_commit` 与 `initial_cursor_commit`（通常都取接入时的 HEAD）；
4. 在 agent-platform-v2 `config/projects.yaml` 按示例登记项目，先 `mode: shadow` 干跑观察；
5. 确认 watcher 状态正常（`/ap workflow status`、`/ap job diagnose workflow-watcher`）后切 `active`；
6. 首个 PLAN 用模板手工创建并提交，走一遍"校验 → 审批卡 → 执行"闭环验证。

## 边界与原则

- 平台代码不硬编码仓库规则值；规则值永远来自目标 Git ref 中已提交的合同。
- watcher 只读已提交内容；同一仓库同一 ref 同一 branch space 只允许一个 workflow consumer
  （接入前确认旧 cron/CI watcher 已停用，避免双消费者）。
- 本套件是模板快照，与平台实现可能有版本差；以平台仓库的
  `docs/workflow/AUTOMATION_GUIDE.md` 为权威操作说明。
