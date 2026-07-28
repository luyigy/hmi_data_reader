---
doc_type: HANDOVER
doc_status: in_progress
next_action: next_slice
plan: docs/288_PLAN_20260728_Workflow权限边界与同Session校验修复.md
slice: S02
plan_progress: in_progress
---

# HANDOVER · Workflow 工作区沙箱 S02 交接

## 完成内容

- S01 Workflow 权限快照在 `platform_local` Codex adapter 启动和 continuation 时重新校验，并强制覆盖
  workdir、workspace root、网络、sandbox 和 approval；普通 Room 权限不能扩大该边界。
- 继续复用 Codex 非交互 JSON 与 Bubblewrap。项目 realpath workdir 是唯一持久可写根，网络保持启用，
  每次运行使用 tmpfs `/tmp`；Codex 状态迁入项目 `.git/agent-platform/codex/<room>`。
- S01 公开的 Codex home 与共享 Agent skills 例外按精确路径只读挂载。Workflow 路径不再扫描可写配置
  目录中的任意软链接目标，避免通过新建软链接读取兄弟目录。
- Bubblewrap 在启动前 canonicalize workspace 和 cwd，显式拒绝路径穿越或 cwd 符号链接逃逸。
- Codex resume 补齐原先遗漏的 `workspaceRoot` 和 `networkAccess` 透传，新建与续跑使用同一操作系统边界。
- Platform Local Codex 的权限能力矩阵现按实际行为报告 sandbox、approval、network 和 writable roots
  均为 `applied`，`policy show` 的 effective/enforcement/exceptions 与执行一致。
- 未修改 watcher validator 派发、permission card、数据库 Schema、目标业务仓库或 S03/S04 行为。

## 验证与影响

- 聚焦测试覆盖并通过：项目内写入、父目录、兄弟项目、系统敏感路径、Docker socket、宿主 `/tmp`、
  路径穿越、cwd 符号链接逃逸、workspace 内软链接逃逸，以及认证/config/skills/plugins/rules 只读例外。
- Workflow 权限、卡片、Live Room workflow/permission、项目配置和 watcher 聚焦测试通过。
- `npx tsc --noEmit`、相关 ESLint、`npm run check:long-files`、`git diff --check` 通过；没有历史超限
  文件增长，也没有新增达到 1000 行的文件。
- GitNexus pre-edit impact 对 Bubblewrap、Codex adapter、Codex execute/resume/JSON 路径均为 LOW。
  S01 新增的权限快照 symbol 因索引落后无法解析；尝试增量 analyze 长时间无进展后停止。提交前
  `detect_changes` 为 LOW、无受影响执行流。
- 开工前已有的 `AGENTS.md`、`CLAUDE.md` 和 `.codex-tmp/` 改动未修改、未纳入本次提交。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/288_PLAN_20260728_Workflow权限边界与同Session校验修复.md` 的 S03：只让 completion gate 把 validator 意见发回当前结果保存的原 session/thread，最多自动纠正两次，相同错误 fingerprint 再现时提前停止；删除 watcher 为 validator 错误派发 `PLAN_VALIDATE_REPAIR` 或其他新 Session 的路径，原 Session 已结束或无法恢复时只向 Task Room 发出完整错误通知并结束本次 gate。先读取目标 HEAD 的 `docs/workflow/workflow-contract.yaml`、本 PLAN、`docs/292_HANDOVER_20260728_Workflow工作区沙箱S02交接.md`、workflow completion gate、session/thread 持久化与 continuation、watcher validator 派发和现有聚焦测试；对将修改的每个 symbol 先运行 GitNexus upstream impact，HIGH/CRITICAL 先报告。不得开始 S04，不改变 S02 文件系统沙箱或 permission card 行为，不修改目标业务仓库。确保 validator 失败不创建或重置 Session、不让原 Session 卡在 `waiting_for_input`，未通过校验的机器可读文档仍不得触发下一 Workflow 动作。完成同 Session 纠正、重复 fingerprint、原 Session 不可用降级通知和 watcher 不派发修复 Session 的聚焦测试，以及 TypeScript、相关 ESLint、long-file guard、`git diff --check` 和 GitNexus `detect_changes` 后提交，并创建 `plan_progress: in_progress`、`next_action: next_slice` 的 S03 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
