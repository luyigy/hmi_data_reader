# 工作流可靠性修复票据草案

依据已完成两轮评审的架构方案，基线 7c0d70b。状态：父规格和 7 张子票已发布到 Gitee 并回读核验，供用户审阅；尚未生成或批准新执行路线，也未启动任务。每票独立验收，执行均使用 poteto-mode。

## 依赖与并行

```text
WR01 ─→ WR02 ─┬→ WR03 ─┐
              ├→ WR04 ─┤
              └→ WR05 ─┼→ WR07
WR06 ──────────────────┘
```

WR01 与 WR06 可先并行。WR02 通过后，WR03/WR04/WR05 可按各自冻结接口并行；同仓独立 worktree 的合流仍须重跑检查。WR07 等待所有真正前置，不重排已成功执行。

## 已发布 Gitee 链接

父规格：[IKNBDN](https://gitee.com/luyi1678/agent-platform-v2/issues/IKNBDN)。

- [WR01：自测与平台检查使用一致的报告运行目录](https://gitee.com/luyi1678/agent-platform-v2/issues/IKNBDO)
- [WR02：检查失败后在同票内自动修复并接续最新成果](https://gitee.com/luyi1678/agent-platform-v2/issues/IKNBDP)
- [WR03：架构和测试发现缺陷后只回修受影响仓内执行](https://gitee.com/luyi1678/agent-platform-v2/issues/IKNBDQ)
- [WR04：集成引用变化和合并冲突有明确的恢复出口](https://gitee.com/luyi1678/agent-platform-v2/issues/IKNBDR)
- [WR05：重启后接续当前阶段且不重复启动写入者](https://gitee.com/luyi1678/agent-platform-v2/issues/IKNBDS)
- [WR06：飞书投递超时不拖停业务执行](https://gitee.com/luyi1678/agent-platform-v2/issues/IKNBDT)
- [WR07：完整故障闭环通过后无损接续现有路线](https://gitee.com/luyi1678/agent-platform-v2/issues/IKNBDU)

## 本地票据草案

- [WR01：自测与平台检查使用一致的报告运行目录](tickets/WR01.md)，前置：无。
- [WR02：检查失败后在同票内自动修复并接续最新成果](tickets/WR02.md)，前置：WR01。
- [WR03：架构和测试发现缺陷后只回修受影响仓内执行](tickets/WR03.md)，前置：WR02。
- [WR04：集成引用变化和合并冲突有明确的恢复出口](tickets/WR04.md)，前置：WR02。
- [WR05：重启后接续当前阶段且不重复启动写入者](tickets/WR05.md)，前置：WR02。
- [WR06：飞书投递超时不拖停业务执行](tickets/WR06.md)，前置：无。
- [WR07：完整故障闭环通过后无损接续现有路线](tickets/WR07.md)，前置：WR03、WR04、WR05、WR06。

## 发布与开工

用户于 2026-10-18 明确要求先发布供其查看，本次已按该指示发布。父子关系、阻塞边及稳定发布标记均已逐票从真实 Issues 回读；published-issues.json 仅是投影，本地草案不是远端依赖的第二来源。待审阅后再生成执行路线包。父规格使用当前收敛方案，既有通用交付规格保持原范围和历史。

发布不等于启动。执行路线必须展示依赖、并行关系、实施与独立验收角色，并遵守现有审批契约；ready-for-agent 标签不能代替路线批准。业务 R01 的恢复属于最后一票的真实验收目标，不因拆票自动重跑。

架构依据：[任务图可靠性方案](../../architecture/task-graph-reliability-draft.md)。ticket-proposal.json 是本次拆分的可审核草案，不是运行时 spec-package，也不是 Issues 的第二依赖来源。
