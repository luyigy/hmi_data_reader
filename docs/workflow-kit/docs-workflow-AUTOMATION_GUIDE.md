<!-- [CHANGE-ME] 下文“agent-platform-v2 部署位置”按实际填写；其余内容仓库无关。 -->

# 工作流自动化指南（agent-platform-v2 监测执行）

## 1. 文档定位

本仓库的 PLAN/HANDOVER 文档工作流由 **agent-platform-v2** 平台监测执行：平台周期扫描本仓库
目标 Git ref 中已提交的工作流文档，校验后驱动审批、Session 派发与接力。

规则值、合法字段、动作、Prompt 标记、编号和阈值只以
[`workflow-contract.yaml`](./workflow-contract.yaml) 为准；本文不复制完整合同。

创建或修订 PLAN 时，还必须读取合同 `standards.plan` 声明的
[`PLAN-writing-standard.md`](./PLAN-writing-standard.md)。

<!-- [CHANGE-ME] 平台部署位置/仓库地址，例如 /data1/code/agent-platform-v2 或内部 git 地址。 -->

## 2. 职责边界

```text
本仓库：合同、模板、PLAN/HANDOVER、需求来源（Inbox/Roadmap）、AGENTS 守则
平台（agent-platform-v2）：调度、校验执行、审批卡、Session 绑定、cursor/幂等账本、
                          长文件检测、失败恢复、飞书通知
```

- watcher 只读目标 ref 的 committed blob，不读工作区未提交文件。
- 自动化候选只包括合同 `automation_types`（PLAN/HANDOVER）；REPORT/FIX/DECISION 等只存档不执行。
- 同一仓库、ref、branch space 只允许一个 workflow consumer；接入前必须停用旧 cron/CI watcher。

## 3. 主状态机（摘要）

- PLAN：默认提交 `ready + await_approval` 留作候选；明确要求“写好后提审”时提交
  `ready + start_first_slice`，watcher 直接发审批卡，批准前不实施。
- 已有候选可在对话中要求提审，Agent 按写作规范定位唯一文档、修改动作并单独提交；也可在 Dashboard
  点击“提交审批”，或在项目绑定的飞书会话发送
  `/ap job activate workflow-watcher --plan=<仓库相对PLAN路径> --head=<监控ref的40位HEAD>`。
  多候选需指定路径时优先使用选择入口；已有 pending 时先处理当前任务，不清空 cursor 或自行启用 watcher。
- HANDOVER：`next_slice` 投递下一 Slice；`resume_parent` 恢复父 PLAN；`await_acceptance` 停下等验收；
  `blocked` / `none` 通知后停止。
- 新 PLAN 永远需要人工审批；`auto` 模式只负责从 Roadmap/Inbox 生成提案，不拥有批准权。

## 4. Agent 完成约定

- 必须先提交 HANDOVER、取得该文档最后一次变更的完整 commit SHA，再结束 Session。
- 完成门禁会校验：新增/修改的工作流文档已提交且通过合同校验、已达阈值的长文件未增长。
- 最终回复需原样重复合同 Prompt 标记之间的下一 Session Prompt，并以
  `WORKFLOW_READY <document_commit_full_sha> <document_basename>` 作为最后一行。

## 5. 常用操作

```text
/ap workflow status
/ap workflow autonomy show
/ap dashboard
/ap job run workflow-watcher
/ap job diagnose workflow-watcher
/ap job cursor workflow-watcher --latest
```

`--latest`、`--clear-pending` 不是常规重试按钮；移动 cursor / 清 pending 必须先诊断确认。

## 6. 安全规则

- 自动化只读已提交内容，不从自然语言正文猜测下一步；元数据无效即停止并报告。
- watcher 已读取提交后，Git 历史只追加：禁止 amend、rebase、reset、强推改写历史。
- 不重复消费同一事件（commit + path + blob + action 幂等）。
- 超时告警不自动 reset；恢复操作须显式命令并在 diagnose 之后执行。

## 7. 维护

- 合法字段/动作/阈值改动：改 `workflow-contract.yaml`，并核对平台 validator 支持面。
- 流程说明改动：改本文件与 `README.md`；历史决策用编号 DECISION 存档。
- 接入与升级清单：参见 agent-platform-v2 仓库 `docs/workflow-kit/README.md`。
