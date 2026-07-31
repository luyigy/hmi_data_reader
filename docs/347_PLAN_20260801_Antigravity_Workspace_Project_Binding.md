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

<!-- HANDOFF_PLAN_SOURCE: cms95xvyw04xtfxwx7ntpcs7u -->

# PLAN · Antigravity Workspace Project 绑定修复

## 背景与目标

在 Agent Platform 调度 Antigravity (agy) 任务时，操作系统层面的 `cwd` 正确传为了目标项目根目录（如 `/data1/code/agent-platform-v2`），但 Antigravity 1.1.9 拥有独立的 Project 选择机制。当前适配器未向 `agy` 传递 `--project` 参数，导致会话默认绑定到 `default-cli-project`。

`default-cli-project` 的 `projectResources` 为空，这导致 Antigravity 后端将模型的代码修改与命令执行（如 `run_command`、`write_to_file`）强制重定向到全局 scratch 目录，无法在工作区原位修改项目文件。

本计划将 Live Room 中的讨论结论整理为标准实施 PLAN：通过在适配器中动态查找并显式传递 `--project=<id>`，并在首次时使用 `--new-project` 自动创建项目资源绑定，确保操作系统 `cwd` 与 Antigravity Project resource 保持一致。

## 关键决策与设计

1. **运行时 Project 检索与参数传递**
   - `executeAntigravityTask` 启动 `agy` 前，按当前任务的 `workingDirectory` 检索已有的 Antigravity Project。
   - 若检索到对应的 Project，在启动参数中注入 `--project=<id>`。
   - 若未找到已存在的 Project，在首次启动时注入 `--new-project` 参数，自动建立 Project 并关联 `workingDirectory`。

2. **控制范围与最小化原则**
   - 保持外层 `spawn` 的 `cwd` 不变。
   - 不增加额外的配置抽象或中间状态持久化，直接依赖 `agy` 原生的 Project 机制。

3. **风险控制 (Risk Level: LOW)**
   - 修改范围严格限定在 `executeAntigravityTask`（Antigravity 本地 runner 模块）。
   - GitNexus 影响分析显示只有 3 个直接调用方与 2 条执行流程，风险等级为 LOW，无全局破坏隐患。

## 切片规划 (Slices)

### S01：Antigravity Runner `--project` 参数与 Project 查找机制实现
- 在 Antigravity runner 中增加根据 `workingDirectory` 匹配 Project ID 的逻辑。
- 动态决定传递 `--project=<id>` 或首发 `--new-project`。
- 确保 `spawn cwd` 保持为工作区目录。

### S02：单元测试与只读 Smoke 验证
- 增加/更新聚焦单元测试，覆盖 Project 存在与不存在场景下的参数生成逻辑。
- 运行 `pwd` 工具命令的只读 smoke 测试，确认工具返回工作目录为 `/data1/code/agent-platform-v2` 而非 scratch 路径。
- 执行 TypeScript 类型检查 (`npm run typecheck`)、代码规范与长文件检查。

### S03：服务生效与端到端验证
- 重启飞书 runtime / 平台服务，保证新 runner 代码生效。
- 验证任务房间正常接收指令并在正确的工作区中执行。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/347_PLAN_20260801_Antigravity_Workspace_Project_Binding.md` 的 S01：只实现和验证 Antigravity runner 按 `workingDirectory` 检索 Project、传递 `--project=<id>` 与首发 `--new-project` 参数逻辑。先读取 `docs/workflow/workflow-contract.yaml`、本 PLAN、最新有效 HANDOVER、Antigravity runner 模块与相关测试；对将修改的 `executeAntigravityTask` 先运行 GitNexus upstream impact 评估。不得开始 S02/S03，不改变 TaskRun 状态、不重启服务。完成聚焦测试、TypeScript 类型检查、ESLint、long-file guard、`git diff --check` 和 GitNexus `detect_changes` 后提交，并创建 `plan_progress: in_progress`、`next_action: next_slice` 的 S01 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
