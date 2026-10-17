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

本轮只发布 Spec 与 tickets，没有启动实施、分配执行 Harness 或修改现有业务路线。`ready-for-agent` 不代替飞书批准。

当前运行时从 Issues 自动提审与派发仍需 W3/W4 完成，不伪造 ready 的 JSON 路线包，不宣称这组 Issues 已能直接驱动整条新流程。

## GitHub 历史

上一轮 Spec 与 tickets 已发布在 GitHub `luyigy/agent-platform-v2` 的 Issues #1–#6，保留作历史参考；本轮未关闭或修改，已不作为本轮实施来源。项目 tracker 配置已切换至 Gitee。
