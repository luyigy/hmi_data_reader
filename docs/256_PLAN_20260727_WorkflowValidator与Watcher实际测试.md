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
# PLAN · Workflow Validator 与 Watcher 实际测试

## 目标

在 `workflow-test` 仓库继续验证 workflow 文档校验与 watcher 的真实行为，明确区分：

1. 手动 validator 的校验结果；
2. `/ap job run workflow-watcher` 的真实运行结果；
3. 前置结构错误与 Prompt 内多个文档引用错误的报告边界。

## S01：构造并手动校验测试样本

保留当前 `006_PLAN_20260727_第四轮假任务.md` 的失败结果作为基线。补齐合同要求的
frontmatter 和唯一一对 Prompt 标记，只在 Prompt 内故意留下多个无效或缺失的文档引用。
提交前手动运行现有 validator，记录它是否一次报告全部引用错误；不新增校验脚本或 AP 命令。

## S02：通过真实 Watcher 复测

将测试样本提交到 `workflow-test` 后，由用户执行：

```text
/ap job run workflow-watcher
```

核对 Run 状态、validator 输出、pending/审批卡是否被阻断，以及错误是否完整汇总。不得用
内部 handler、临时 Node 进程或直接写数据库替代 AP 命令。

## S03：记录结果并收口

若行为符合合同，记录测试结果并恢复或终结测试样本；若发现实现缺陷，先做 GitNexus
upstream impact，再实施最小根因修复和聚焦回归测试。不得把测试仓库的故意错误带入平台仓库。

## 验收标准

- 手动 validator 与 watcher 对同一已提交文档给出可解释的一致结果。
- 能确认多个 Prompt 文档引用错误是集中报告、逐个报告，还是在首错停止。
- 结构错误不会创建 pending 或审批卡。
- 只有合同校验完全通过的文档才进入后续 watcher 流程。
- 真实测试命令、Run 结果和结论被记录，且不以内部调用冒充端到端测试。


