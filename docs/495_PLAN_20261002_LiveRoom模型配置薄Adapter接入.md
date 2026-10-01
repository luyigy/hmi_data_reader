---
doc_type: PLAN
doc_status: ready
next_action: await_approval
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · Live Room 模型配置薄 Adapter 接入

## 目标、现状与路线

用户为房间成员查询或设置模型时，平台只处理通用命令与保存，各 Harness 自己处理模型目录、Provider 组合和思考档位差异。以后接入新 Harness，无须再给模型配置命令增加同类分支。

当前执行路径已有 `HarnessAdapter` 注册表，但 `/ap model-config` / `/ap codex-config` 在 `feishu-live-room-commands.ts` 按 Harness 分支查询目录、组合 Pi Provider、校验 Codex 目录；`live-room-codex-settings.ts` 另有按类型分支的能力与格式校验。成员 API 和 Pi 执行入口也调用后者。Kimi `--list` 的修复延续了这套分支。已确认的现状不是 PLAN 485 S06 的验收内容。

PLAN 485 S01–S06 处理**本轮实际运行状态的采集、展示与验收**；PLAN 481 S05–S06 处理**原生终端试点的待生效设置与飞书卡片**，虽写有“委托目标 adapter”，没有覆盖当前四类成员的既有命令与成员 API。因此本计划作为独立 Slice PLAN，只有 S01；不把配置重构塞入任一计划的验收 Slice，也不以此阻塞它们已划定的工作。完成后，四类现有配置行为保持一致，模型配置的 Harness 差异集中在各自 adapter。

## S01：四类 Harness 的模型配置经由现有 Adapter

- **目的**：移除模型配置命令和公共设置模块持续累积的 Harness 类型分支。
- **完成后结果**：Codex、Pi、Antigravity、Kimi Code 的受支持成员仍能按原语义查看和保存下一轮请求值；Codex、Pi、Kimi 的本机目录查询仍可用。新增 Harness 的模型规则只需接到自身 adapter/注册，命令层无需增加类型判断。
- **实现方法**：在现有 `HarnessAdapter` 增加可选、薄的模型配置能力，复用现有目录读取、格式校验与成员字段，不新建第二套 adapter。各实现持有本 Harness 的支持字段、规范化/校验及可用时的目录查询；Pi Provider 组合和 Codex 目录选择校验留在对应实现。命令层和成员 API 经 registry 调用同一能力，保留 `/ap codex-config` 只接 Codex 的兼容入口，以及现有“设置下一轮生效”语义。目录查询必须受成员 backend 限制，不能用 Platform Local 的目录代表远端；无目录能力时明确提示。执行入口沿用同一校验规则，避免保存与运行口径分叉。先追踪全部调用方，选择最小兼容迁移，不因接口可选而要求无关 Harness 改动。
- **修改边界**：`src/lib/harness/types.ts`、四类 `src/lib/harness/adapters/` 实现、`src/lib/feishu-live-room-commands.ts`、`src/lib/live-room-codex-settings.ts`、成员 API 和 Pi 执行入口的必要接点，以及现有直接测试。文件数超过默认预警，因为同一配置协议同时被命令、API 与执行消费，必须保持这些入口一致；不改数据库、实际运行状态遥测、原生终端时序、卡片 UI 或远端 runner 协议。
- **验收**：直接测试证明命令与成员 API 的能力/校验一致；Codex 目录与档位、Pi Provider/模型组合、Antigravity 档位、Kimi `--list` 与拒绝 `--thinking` 保持原行为；`inherit`、无效输入、无目录、远端成员不得读取本机目录和保存失败不写库均覆盖。运行现有相关测试、`npx tsc --noEmit`、`npm run check:long-files`、`git diff --check`；保留已有未提交改动，只暂存本 Slice。
- **前置与停止条件**：开工先读合同、本文并跑长文件守卫；共享接口按 AGENTS 要求做 GitNexus 影响检查，再以源码核实调用方。若发现必须改数据库或远端 runner 才能维持原行为，停止并修订计划；无真实目录的 Harness 不伪造目录。
- **交付物**：代码、针对性回归检查、独立提交和 S01 终态 HANDOVER，完成后停止。

## 验收与退出

本计划完成以命令、成员 API、执行入口共用 adapter 能力且现有四类行为无回退为准。它不宣称 PLAN 485 的真实模型遥测或 PLAN 481 的原生终端设置已经完成。工作区现有未提交业务改动不得混入本计划提交；Git 历史只追加。

本 PLAN 为 `ready / await_approval` 候选，不自动提审或实施。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/495_PLAN_20261002_LiveRoom模型配置薄Adapter接入.md` 的 S01；读取目标 HEAD 的 `AGENTS.md`、`docs/workflow/workflow-contract.yaml`、合同引用的 PLAN 标准和本 PLAN。先跑长文件守卫，核实模型配置全部调用方及 GitNexus 共享接口影响；在现有 HarnessAdapter 增加薄的可选模型配置能力，让四类 Harness 的目录、Provider、档位和校验留在各自 adapter，命令与成员 API 走统一入口。保持远端目录边界、现有保存/运行语义及工作区其他改动。完成针对性测试和门禁，用 `workflow:new` 生成 S01 HANDOVER，暂存本 Slice 后运行 preflight，仅提交本 Slice 并停止；不启动 PLAN 485 或 481 的后续 Slice，不重启服务或外发消息。
<!-- WORKFLOW_PROMPT_END -->
