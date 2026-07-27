---
doc_type: PLAN
doc_status: completed
next_action: await_acceptance
plan_kind: phase
roadmap: 224_PLAN_20260725_通用项目定时任务平台.md
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · Workflow Completion Gate 触发边界修复

## 背景

workflow completion gate 当前对所有 `platform_local` 执行建立 baseline。baseline 最近开始读取
并校验已提交的 workflow contract，导致普通飞书直聊和普通 Codex 任务也依赖自动化工作流
合同；当工作区代码与已提交合同版本不一致时，非自动化对话同样失败。

## 目标

只在明确的自动化 workflow 执行上下文启用 completion gate。普通飞书直聊、普通本地任务和
其他非 workflow 执行不得读取 workflow contract，也不得被 workflow 文档校验阻断。

## S01：收紧 Completion Gate 触发边界

1. 使用 GitNexus 追踪 `getWorkflowCompletionBaseline`、`assertWorkflowCompletion` 和
   `executeAcpxTaskRun` 的调用及请求来源；修改任何 symbol 前逐一执行 upstream impact，
   HIGH/CRITICAL 风险先报告。
2. 优先复用现有 workflow 执行标识；若不存在，只沿现有请求链传递一个最小显式标识，不新增
   workflow context 抽象、注册表或通用策略层。
3. 普通 `platform_local` 执行跳过 baseline 和 contract 解析；workflow watcher 或其他明确的
   自动化入口继续执行开始、完成两端的校验。
4. 补最小回归测试：普通本地执行不读取 malformed/版本不匹配的 workflow contract；自动化
   workflow 执行仍会调用 completion gate 并阻止无效文档完成。
5. 运行聚焦测试、TypeScript、`git diff --check` 和 GitNexus `detect_changes`。不提交、
   不重启服务；若修复需要改变数据库、公共 API 或现有自动化入口，停止并报告范围扩张。

## 验收标准

- 普通飞书直聊和普通 Codex 本地任务不建立 workflow baseline。
- 非自动化任务不读取或校验 `docs/workflow/workflow-contract.yaml`。
- workflow watcher/自动化 Session 仍执行 completion gate。
- 合同与 validator 的版本不一致只影响明确使用该合同的自动化任务。
- 测试能直接区分普通执行与自动化执行，避免再次由全局 `platform_local` 条件触发。

## 完成结果

- 复用 live-room 消息已有的 `source: workflow_watcher` 标识，只为该来源启用 gate。
- `AcpxRunRequest` 新增可选布尔字段；所有既有调用方默认关闭。
- 普通 `platform_local` 执行不再读取 workflow contract。
- watcher 触发的本地执行仍在开始和完成时执行 completion gate。
