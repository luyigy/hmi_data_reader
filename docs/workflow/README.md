# 工作流自动化入口

这里是 workflow 自动化的稳定入口，不是第二份规则源。

## 先读什么

1. [workflow-contract.yaml](./workflow-contract.yaml)：唯一机器可读规则源。
2. [AUTOMATION_GUIDE.md](./AUTOMATION_GUIDE.md)：当前状态机、自治模式、Roadmap/Inbox、恢复与操作说明。
3. [PLAN 写作与 Slice 划分规范](./PLAN-writing-standard.md)：合同声明的跨仓写作标准。
4. [PLAN.md](./templates/PLAN.md) / [HANDOVER.md](./templates/HANDOVER.md)：合同合格的最小文档模板。
5. [Git Inbox 约定](../inbox/README.md)：`auto` 模式候选需求的存放规则。
6. [状态机决策记录](./225_DECISION_20260725_文档自动化状态机.md)：为什么采用 Git 文档事件驱动。

## 当前实现状态

- `workflow-watcher` 已由通用 Scheduled Job Runner 每分钟调度，并支持 TaskRun 完成事件即时唤醒。
- 本项目静态配置为 `enabled + active + semi_auto`；数据库 override 可能改变有效自治模式，以
  `/ap workflow status` 或 `/ap workflow autonomy show` 为准。
- watcher 只读取配置 Git ref 中已提交的 PLAN/HANDOVER；不消费工作区文件，也不从正文猜动作。
- PLAN 以 `await_approval` 进入清单，选择后必须先经人工审批；批准后运行态才转换为 `start_first_slice`。
- `auto` 可在 Phase PLAN 完成后从 Roadmap 或 `docs/inbox/` 生成下一份审批 PLAN，但不会自动批准或实施它。
- 状态、cursor、pending、幂等键和运行记录保存在 Agent Platform PostgreSQL，不提交回业务仓库。

## 文档边界

- `PLAN` / `HANDOVER`：自动化文档，必须遵守合同和模板。
- `ROADMAP` / `ISSUE`：需求来源，不会直接启动 Session。
- `DECISION` / `ARCH` / `FIX` / `REPORT`：知识沉淀，不触发 workflow。

不要再创建一套 Wiki 规则副本。长期说明更新本目录，机器规则只改合同；历史验收和故障证据继续放编号
REPORT/FIX 文档。
