---
doc_type: ROADMAP
doc_status: active
next_action: none
---

# Inbox 议题优先级排期与实施规划 (2026-08-04)

## 评估维度与标准

针对 `docs/inbox/` 下存储的所有待办议题，综合**痛点紧迫度、开发性价比、影响范围与系统稳定性**进行多维度盘点，形成后续研发迭代的优先级梯度指南。

---

> **2026-08-04 修订**：新增 379（Workflow 编排失败恢复收据与断点继续），源自当日 `/plan` 真实事故。建议将 379 + 376 + 348 作为“失败可观测性与恢复”主题簇合并排期：379 提供失败收据与断点继续，376 覆盖 PLAN 提交链阶段反馈，348 修复长任务误判；三者代码路径相邻、收益叠加。379 因触发于真实事故且其 P0 子步骤改动极小，列为第一梯队首位。

## 🟢 第一梯队：建议立即优先排期（高感知收益，解决现实痛点）

1. **[379_ISSUE_20260804_Workflow编排失败恢复收据与断点继续.md](file:///data1/code/agent-platform-v2/docs/inbox/379_ISSUE_20260804_Workflow%E7%BC%96%E6%8E%92%E5%A4%B1%E8%B4%A5%E6%81%A2%E5%A4%8D%E6%94%B6%E6%8D%AE%E4%B8%8E%E6%96%AD%E7%82%B9%E7%BB%A7%E7%BB%AD.md)**
   - **优先级**：P1（主题簇牵头项）
   - **推荐理由**：触发于 2026-08-04 真实事故——`antigravity` 在 `/plan` “成员建议”阶段因受限沙箱启动崩溃，平台却统一提示“PLAN 未提交”，误导用户查 PLAN 文件/Git。其 P0 子步骤（区分成员执行失败 / PLAN_PATH 非法 / Git 提交失败 / validator 失败）改动极小、即时澄清；P1 子步骤提供轻量 Workflow Run checkpoint，支持“从失败阶段继续”，避免整轮重跑。

2. **[376_ISSUE_20260804_用户分支变更致Watcher阻断与Handoff链生成计划状态反馈优化.md](file:///data1/code/agent-platform-v2/docs/inbox/376_ISSUE_20260804_%E7%94%A8%E6%88%B7%E5%88%86%E6%94%AF%E5%8F%98%E6%9B%B4%E8%87%B4Watcher%E9%98%BB%E6%96%AD%E4%B8%8EHandoff%E9%93%BE%E7%94%9F%E6%88%90%E8%AE%A1%E5%88%92%E7%8A%B6%E6%80%81%E5%8F%8D%E9%A6%88%E4%BC%98%E5%8C%96.md)**
   - **优先级**：P1
   - **推荐理由**：解决近期真实发生的“分支切换致 Watcher 静默挂起”及 Handoff 生成计划过程中缺少明确阻断反馈的问题。实施后可提供链路状态诊断与卡片自动告警，极大地降低运维和定位成本。与 379 共用失败提示分类思路，建议同批实施。

3. **[377_ISSUE_20260804_Agent执行过程详细信息折叠显示方案.md](file:///data1/code/agent-platform-v2/docs/inbox/377_ISSUE_20260804_Agent%E6%89%A7%E8%A1%8C%E8%BF%87%E7%A8%8B%E8%AF%A6%E7%BB%86%E4%BF%A1%E6%81%AF%E6%8A%98%E5%8F%A0%E6%98%BE%E7%A4%BA%E6%96%B9%E6%A1%88.md)**
   - **优先级**：P1
   - **推荐理由**：解决日常使用中最直接的“消息刷屏/界面混乱”感知问题。在飞书（`collapsible_panel` 原位卡片更新）和 Web 端引入中间步骤折叠，保持对话主线清爽且保留全量追溯能力。亦可为 379 的“查看诊断”提供折叠容器基础。

---

## 🟡 第二梯队：建议紧随其后（提升系统可靠性与快捷交互）

4. **[348_ISSUE_20260731_FeishuWatchdog误判PlatformLocal长任务.md](file:///data1/code/agent-platform-v2/docs/inbox/348_ISSUE_20260731_FeishuWatchdog%E8%AF%AF%E5%88%A4PlatformLocal%E9%95%BF%E4%BB%BB%E5%8A%A1.md)**
   - **优先级**：P1（属“失败可观测性与恢复”主题簇，建议随 379/376 一起做）
   - **推荐理由**：修复 Watchdog 误将 >12 分钟的活跃 Local 进程判定为失败并强行把成员改回 `idle` 的状态分裂 bug。直接保障长任务交付稳定性，与 379 的成员失败判定链路同源。

5. **[375_ISSUE_20260804_AP命令卡片增加角色工作流入口.md](file:///data1/code/agent-platform-v2/docs/inbox/375_ISSUE_20260804_AP%E5%91%BD%E4%BB%A4%E5%8D%A1%E7%89%87%E5%A2%9E%E5%8A%A0%E8%A7%92%E8%89%B2%E5%B7%A5%E4%BD%9C%E6%B5%81%E5%85%A5%E5%8F%A3.md)**
   - **优先级**：P2 (Quick Win)
   - **推荐理由**：改动小、见效快。在 AP 命令卡片中直接加上 `/run feature` 和 `/run debug` 的可视化按钮，减少记忆命令门槛。

---

## 🔵 第三梯队：中长期演进与安全基石

6. **[357_ISSUE_20260801_网页平台登录认证与RBAC.md](file:///data1/code/agent-platform-v2/docs/inbox/357_ISSUE_20260801_%E7%BD%91%E9%A1%B5%E5%B9%B3%E5%8F%B0%E7%99%BB%E5%BD%95%E8%AE%A4%E8%AF%81%E4%B8%8ERBAC.md)**
   - **优先级**：P2
   - **说明**：网页鉴权与 RBAC 权限隔离（安全基础）。
7. **[351_ISSUE_20260801_并行工作流调度与GitWorktree任务隔离执行.md](file:///data1/code/agent-platform-v2/docs/inbox/351_ISSUE_20260801_%E5%B9%B6%E8%A1%8C%E5%B7%A5%E4%BD%9C%E6%B5%81%E8%B0%83%E5%BA%A6%E4%B8%8EGitWorktree%E4%BB%BB%E5%8A%A1%E9%9A%94%E7%A6%BB%E6%89%A7%E8%A1%8C.md)**
   - **优先级**：P2
   - **说明**：多 Agent 并发与 Git Worktree 隔离（架构演进）。
8. **[350_ISSUE_20260801_远程Agent守护进程与WebSocket接入网络.md](file:///data1/code/agent-platform-v2/docs/inbox/350_ISSUE_20260801_%E8%BF%9C%E7%A8%8BAgent%E5%AE%88%E6%8A%A4%E8%BF%9B%E7%A8%8B%E4%B8%8EWebSocket%E6%8E%A5%E5%85%A5%E7%BD%91%E7%BB%9C.md)**
   - **优先级**：P3
   - **说明**：跨机器分布式 Agent 协作网络（分布式扩展）。

---

## ⚪ 暂缓 / 维护项

- **[347_ISSUE_20260731_WorkflowValidator沙箱绝对路径依赖.md](file:///data1/code/agent-platform-v2/docs/inbox/347_ISSUE_20260731_WorkflowValidator%E6%B2%99%E7%AE%B1%E7%BB%9D%E5%AF%B9%E8%B7%AF%E5%BE%84%E4%BE%9D%E8%B5%96.md)**
  - **说明**：仅报警告，当前有 fail-open 保护，建议配合后续 Watcher 维护合入。
- **[349_ISSUE_20260801_网页平台登录认证与Inbox快捷记录命令.md](file:///data1/code/agent-platform-v2/docs/inbox/349_ISSUE_20260801_%E7%BD%91%E9%A1%B5%E5%B9%B3%E5%8F%B0%E7%99%BB%E5%BD%95%E8%AE%A4%E8%AF%81%E4%B8%8EInbox%E5%BF%AB%E6%8D%B7%E8%AE%B0%E5%BD%95%E5%91%BD%E4%BB%A4.md)**
  - **说明**：已废弃 (`superseded`)，需求已被拆分至 352 与 357 议题中。
