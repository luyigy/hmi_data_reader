# 工作流收敛 Spec 包

本轮使用 Matt 的 `to-spec` 和 `to-tickets`；用户指定 Gitee 为新的工作来源。

- `spec.md`：Gitee 父 Spec Issue 全文的本地版本化镜像。
- `route-review.html`：已发送至飞书的方案及本地操作演示。
- 本索引只列来源，不维护第二套任务进度。

## Gitee Tracker

- [[Spec] 可对话、受限执行、以 Issues 管理的任务工作流](https://gitee.com/luyi1678/agent-platform-v2/issues/IKMG1N)
- [[W1] 在任务话题中持续问答并补材料接续原任务](https://gitee.com/luyi1678/agent-platform-v2/issues/IKMG1O)
- [[W2] 在细化权限的本机沙箱中完成一次受控交付](https://gitee.com/luyi1678/agent-platform-v2/issues/IKMG1P)
- [[W3] 从 Spec 和 GitHub/Gitee Issues 在飞书生成路线提审](https://gitee.com/luyi1678/agent-platform-v2/issues/IKMG1Q)
- [[W4] 按获批 Issues 关系自动集成、同步并接力](https://gitee.com/luyi1678/agent-platform-v2/issues/IKMG1R)
- [[W5] 导入 mold 与 Reader 既有结果并验证真实跨仓续跑](https://gitee.com/luyi1678/agent-platform-v2/issues/IKMG1S)

W1/W2/W3 无前置，W4 被三者阻塞，W5 被 W4 阻塞。每张 Issue 的 `ap-ticket-v1` 结构化字段已通过 API 回读；引用存在、父子归属、标签及无循环均已核验。

这些是正文兼容关系，不是 Gitee 原生的阻塞 UI 或服务端派发能力。关系和实时状态在 tracker 管理，本文件仅是发布索引。

## 执行状态

- [本轮集中变更记录](change-record-20261017.md)：当前约定、替代方案、提交、发布、实际业务状态和遗留问题。
- [项目运行环境配置](../../architecture/project-runtime-environments.md)：复用已有虚拟环境的选择规则与权限。

逐次实施结果、提交与未验证项见同目录 `execution-status.md`。按用户最新要求，后续每个 Session 只推进一个可验收单元。

用户随后明确授权 Codex 按 W1→W5 顺序亲自实施。代码在 `feat/workflow-convergence-20261017` 集成分支开发，逐片验证并回写对应 Issue；未部署及未完成真实业务验收的部分不关闭为完成。

W3 将提审入口改为读取 Issue 关系，包内执行配置不重复声明依赖。W4 接续处理运行中的同步和放行。此索引不代替运行账本或远端进度。

## GitHub 历史

上一轮 Spec 与 tickets 已发布在 GitHub `luyigy/agent-platform-v2` 的 Issues #1–#6，保留作历史参考；本轮未关闭或修改，已不作为本轮实施来源。项目 tracker 配置已切换至 Gitee。
