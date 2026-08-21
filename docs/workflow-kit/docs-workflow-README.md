<!-- [CHANGE-ME] 替换本文件中三处标注后，作为 docs/workflow/README.md 提交。 -->

# 工作流自动化入口

- 唯一机器可读规则源：[workflow-contract.yaml](./workflow-contract.yaml)
- 文档骨架：[templates/PLAN.md](./templates/PLAN.md)、[templates/HANDOVER.md](./templates/HANDOVER.md)
- 平台监测执行操作指南：[AUTOMATION_GUIDE.md](./AUTOMATION_GUIDE.md)
<!-- [CHANGE-ME] 若有历史决策文档（如编号 DECISION_文档自动化状态机），在此补链接。 -->

## 平台监测执行

<!-- [CHANGE-ME] 以下三项按平台 config/projects.yaml 中本项目的实际注册值填写。 -->

- 自动化扫描边界：`docs/codex/<branch-space>/`（合同 `branch_spaces.root` + 平台 `branch_space`）
- 配置 Git ref：`refs/heads/<branch>`
- 监测执行方：agent-platform-v2（workflow-watcher，自治模式 `semi_auto`，执行策略 `workspace|full_access`）

常用操作见 `AUTOMATION_GUIDE.md`（`/ap workflow status`、`/ap job run workflow-watcher`、`/ap dashboard` 等）。
