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

# PLAN · Workflow 模板、校验修复与 Inbox 录入闭环

<!-- WORKFLOW_INBOX_ITEM: 2acc339ea7317cd6 -->
<!-- WORKFLOW_INBOX_ITEM: a28566ae8ed3eaf0 -->

## 来源与选择结论

本轮合并处理：

- `docs/inbox/347_ISSUE_20260731_WorkflowValidator沙箱绝对路径依赖.md`：完整纳入。
- `docs/inbox/349_ISSUE_20260801_网页平台登录认证与Inbox快捷记录命令.md`：只纳入 Inbox 快捷录入、校验和后续转 PLAN 的部分。
- 当前 Live Room 已确认的 Workflow 模板、`balanced / strict` 校验模式、状态查看和受控修复入口。

这些工作共享目标仓库中的 `workflow-contract.yaml`、PLAN/HANDOVER 生成与校验、Git guard、项目绑定和
Feishu `/ap workflow` 控制面，适合在同一轮完成并复用一组隔离仓库测试。

本轮不纳入：

- 349 的网页登录、Session、OAuth、JWT 和 RBAC；先拆回独立 Inbox ISSUE，再单独做威胁模型和全路由盘点。
- `348_ISSUE_20260731_FeishuWatchdog误判PlatformLocal长任务.md`；它属于 Live Room process/liveness
  终态一致性修复。
- `350_ISSUE_20260801_远程Agent守护进程与WebSocket接入网络.md`；它需要独立节点鉴权和网络协议设计。
- `351_ISSUE_20260801_并行工作流调度与GitWorktree任务隔离执行.md`；它依赖并发所有权、合并和冲突策略。

## 目标

建立一条最小、可见、目标仓库自持有的 Workflow 文档链路：

1. 每个目标仓库版本化保存合同和最小 PLAN/HANDOVER 模板；平台只提供显式初始化母版和路径提示，运行时
   不注入隐藏模板，Validator 仍只以目标 Git ref 中已提交的合同为规则源。
2. `balanced` 模式只阻断会导致错误调度的结构/动作/引用/唯一 Prompt/目标 HEAD 问题，其余已启用策略规则
   产生 warning；`strict` 将这些策略 warning 升为阻断错误。
3. Git guard 在看不到 Agent Platform 安装目录和 `node_modules` 的沙箱中仍可运行 Validator；运行环境故障
   继续 fail-open，已证明的可执行文档错误继续 fail-closed。
4. 用户可查看校验状态、切换模式、查看当前错误对应的最小模板片段，并对当前失败发起一次幂等受控修复。
5. 用户可从已绑定项目的 Feishu 会话用一个 `/ap inbox add` 入口把需求写入目标仓库 Git Inbox；录入不会
   自动实施，后续仍复用既有 Inbox 提案和 PLAN 审批链。

不建立模板中心、第二套 Validator、第二套审批/任务状态机、通用 Git 写入框架或六个独立卡片开关。

## 语义合同

### 目标仓库是运行时事实源

- 目标仓库使用 `docs/workflow/workflow-contract.yaml` 与 `docs/workflow/templates/PLAN.md`、
  `docs/workflow/templates/HANDOVER.md`；路径可由项目现有 `branch_space / contract_path` 推导，不新增数据库副本。
- 平台内置内容只在显式初始化或升级预览时作为母版；复制到目标仓库并提交后，Agent、hook、watcher 和生成器
  全部读取目标 HEAD。缺文件时明确报告未初始化，不静默回退到平台版本。
- 模板是合同合格示例，不被 Validator 反向解析为规则；合同与模板变化必须进入同一个追加提交。

### 校验分级

- `document_invalid`、`runtime_unavailable` 的既有分类继续保留；新增的 warning 不得伪装成运行故障。
- hard gate 始终保护可执行调度安全：合同/YAML 可解析、动作合法、引用存在且不越界、唯一非空 Prompt、
  目标 HEAD、append-only 历史和长文件不增长。
- 已有六项策略规则继续由合同启停；`balanced` 下报告 warning 但不阻断，`strict` 下阻断。`draft + none`
  只做 soft lint，不启动修复 Session。
- 诊断返回稳定错误代码、严重级别、位置、期望值、实际值和对应的最小模板片段；调用方不得靠中文错误字符串
  猜分类。

### 写操作与幂等

- 模式切换、初始化和 Inbox 录入只允许平台管理员或项目审批人操作，携带预期 40 位 HEAD；HEAD 变化、
  非 branch ref、工作区冲突或多个 workflow consumer 时 fail closed。
- 合同/模板/Inbox 的真实变化各自产生一个只追加提交；重复命令或卡片回调以项目、HEAD、请求和内容指纹幂等。
- 修复优先恢复原执行 Session；没有可恢复 Session 时，才为同一 `path + blob` 启动至多一个受控修复任务。
  相同错误且 blob 未变化时停止，不循环派单。
- `/ap inbox add` 只创建 `doc_status: draft / next_action: none` 的 ISSUE 并提交，不改变自治模式、不领取 ISSUE、
  不生成或批准 PLAN。

## S01：目标仓库模板、分级诊断与 Issue 边界整理

1. 在目标仓库补齐最小 PLAN 与 HANDOVER 权威模板，并更新 `AUTOMATION_GUIDE.md` / Agent 路径指令；模板覆盖
   phase PLAN、interrupt PLAN、继续下一 Slice、恢复父 PLAN和终止动作所需的最小合法片段。
2. 在合同中加入 `balanced / strict` 模式，保留已有策略规则启停项；将 Validator 内部 issue 改为稳定 code、
   `error / warning` 严重级别和结构化详情，同时保持现有文本调用方兼容。
3. `balanced` 只把策略项降为 warning，不放松 hard gate；`strict` 保持当前全部规则阻断。
4. 为每类错误返回对应模板片段，不把整份合同或整份模板重复塞入修复 Prompt。
5. 将 349 中未纳入的网页登录认证/RBAC 原样拆为新的 draft ISSUE；待本 PLAN 完成时把原 349 标记为
   `superseded` 并引用新 ISSUE 与本 PLAN，保证未实施需求不丢失、也不被错误标记为已完成。

完成标准：

- 目标 HEAD 中合同、模板和指南一致，模板本身通过 Validator；缺模板时诊断清楚但不形成第二规则源。
- 同一策略错误在 balanced 为 warning、strict 为 error；结构/调度错误在两种模式均阻断。
- 既有合法/非法 PLAN、HANDOVER、draft 文档和 runtime failure 回归测试通过。
- 只完成 S01；创建 `plan_progress: in_progress`、`next_action: next_slice` 的 S01 HANDOVER 后停止。

## S02：沙箱可执行的 Git guard Validator

1. 修改 guard 安装流程，把普通 Node.js 可直接执行的 Validator 运行产物安装到目标仓库 Git dir 下的
   `agent-platform/`；hook 不再引用 Agent Platform 绝对路径、`ts-node` 或平台 `node_modules`。
2. 运行产物读取提交目标 ref 中的合同和文档，不复制合同、不依赖目标工作区文件；安装器重复运行时幂等升级。
3. 保持当前边界：文档验证明确失败才拒绝 commit；bundle 缺失、Node 启动失败或依赖损坏时警告并允许 commit，
   watcher 后续仍暂停未通过 hard gate 的自动派发。
4. 覆盖完全不可见平台目录的沙箱、合法/非法文档、运行故障 fail-open、非 workflow commit、ref 删除和
   non-fast-forward 拦截；在 HMI Reader 真实沙箱验收前另取外部动作授权。

完成标准：

- 隔离测试证明 hook 不读取平台路径或平台依赖，合法文档无 runtime warning，非法文档被拒绝。
- watcher/runner 重装可升级旧 v1/v2 managed hook，不覆盖 unmanaged hook。
- 不扩大 Bubblewrap 挂载，不向目标项目安装 npm 依赖。

## S03：校验控制面与受控修复

复用现有 `/ap workflow`、项目绑定、管理员/审批人权限、HEAD 乐观锁、审计记录和 workflow status：

1. `/ap workflow validation show` 展示项目/ref/HEAD、模式、hard gate、策略规则、最后失败文档、错误类型、
   error/warning 数量和唯一下一步。
2. `/ap workflow validation set balanced|strict --head=<HEAD>` 预览并提交合同与同步模板的最小追加修改；
   过期 HEAD、dirty/conflicting worktree、无权限或非唯一 consumer 拒绝执行。
3. `/ap workflow validation template` 展示当前错误对应的最小片段。
4. `/ap workflow validation repair --head=<HEAD>` 优先恢复原 Session；否则按 `path + blob` 只创建一次受控修复，
   使用现有 completion gate、watcher 状态和通知，不新增 repair queue。
5. 命令中心/卡片只展示 `balanced / strict` 两档和上述四个动作；高级六项开关暂不做 UI。

完成标准：

- show/template 为只读；set/repair 有权限、HEAD、dirty tree、重复回调和服务重启测试。
- 同一 blob 不重复派单；修复产生新 blob 后重新校验，两次仍失败时停止并明确通知。
- 模式配置只存在目标仓库合同，数据库仅保留请求审计与运行期 repair checkpoint。

## S04：Feishu Inbox 快捷录入与端到端收口

1. 增加 `/ap inbox add <标题> [--body=<说明>] --head=<HEAD>`；只支持已绑定且唯一的 Workflow 项目，复用
   现有命令解析、项目权限和 branch space 规则。
2. 生成递增编号、规范文件名和 ISSUE frontmatter，写入目标 `docs/inbox/`；标题/正文做长度、控制字符、
   路径穿越和敏感字段边界检查，不执行用户正文中的命令。
3. 在提交前重新核对 HEAD 和 clean/conflict 状态；同一消息/内容重复提交返回已存在 ISSUE，不能产生两个文件。
4. 验证现有 auto Inbox consumer 可读取新 ISSUE、生成唯一 PLAN 并等待审批；manual/semi_auto 不自动消费。
5. 完成 349 的拆分/引用收口；不实现独立 `ap` CLI、定期轮询器或新排期队列，因为现有 Feishu 命令和
   watcher 已覆盖第一版需要。

计划终态完成标准：

- 在隔离仓库完成“初始化模板 → balanced/strict 校验 → 沙箱 commit guard → show/template/repair →
  Inbox 录入 → Auto 提议 PLAN → 审批前停止”的端到端测试。
- `npm run test:workflow-validator`、`npm run test:git-history-guard`、相关 workflow watcher/command/approval 测试、
  `npx tsc --noEmit`、定向 ESLint、`npm run check:long-files` 和 `git diff --check` 通过。
- 每个 Slice 修改任一 function/class/method 前运行 GitNexus upstream impact；HIGH/CRITICAL 先报告。
- 提交前运行 GitNexus `detect_changes`，只提交本 Slice 文件；终态创建 `plan_progress: complete`、
  `next_action: await_acceptance` 的 S04 HANDOVER 后停止。

## 风险与控制

- **提交链路风险：** guard/validator 位于所有受监控仓库提交路径。S02 先在临时仓库证明 fail-open/fail-closed
  分类，再做目标项目验收；不得直接替换 unmanaged hook。
- **规则漂移：** 平台母版、目标模板和合同可能不同步。运行时永远读取目标 HEAD；初始化只做显式复制，
  模板不参与规则解析。
- **Git 并发：** set、repair、inbox add 都可能与 Agent 提交冲突。每次写入前后核对 HEAD，dirty 或变更即停止，
  不 stash、不 reset、不覆盖用户改动。
- **权限与内容：** Git 写入复用现有管理员/审批人边界；Inbox 正文只作为 Markdown 数据保存，不执行、不展开
  URL、不保存 Token 或凭证。
- **外部动作：** 未经用户在对应 Slice 明确授权，不重启服务、不发送真实 Feishu 消息、不修改共享数据库、
  不切换真实项目模式、不改 HMI Reader；先完成 fake sender 与临时仓库验证。
- **长文件：** 当前无 1000 行阻断文件；已有接近阈值文件不得增长，新职责优先落入明确 owner 模块。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/352_PLAN_20260801_Workflow模板校验与Inbox录入闭环.md` 的 S01：先读取目标 HEAD 的 `AGENTS.md`、
`docs/workflow/workflow-contract.yaml`、本 PLAN、
`docs/inbox/347_ISSUE_20260731_WorkflowValidator沙箱绝对路径依赖.md`、
`docs/inbox/349_ISSUE_20260801_网页平台登录认证与Inbox快捷记录命令.md`，以及 workflow validator、模板/指南、
文档生成器和相关测试。保护所有开工前用户改动，运行 `npm run check:long-files`。只完成 S01：在目标仓库建立
合同合格的最小 PLAN/HANDOVER 模板；加入 balanced/strict 分级和带稳定 code、severity、位置、期望/实际值、
最小模板片段的结构化诊断；保持现有文本调用兼容；把 349 未纳入的网页登录认证/RBAC 拆为新的 draft ISSUE，
不得开始 S02–S04，不实现 Git guard bundle、修复命令或 Inbox 命令。修改任一 function/class/method 前运行
GitNexus upstream impact，HIGH/CRITICAL 先报告。完成 workflow validator 和模板聚焦测试、TypeScript、定向
ESLint、`npm run check:long-files`、`git diff --check` 与 GitNexus detect_changes 后精确提交，并创建
`plan_progress: in_progress`、`next_action: next_slice` 的 S01 HANDOVER；提交后立即停止。
<!-- WORKFLOW_PROMPT_END -->
