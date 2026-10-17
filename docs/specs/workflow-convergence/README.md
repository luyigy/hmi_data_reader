# 工作流收敛 Spec 包

本轮实际使用 Matt 的 `to-spec` 和 `to-tickets` 发布到 GitHub。

- `spec.md`：父 Spec Issue 全文的本地版本化镜像。
- `route-review.html`：已在当前飞书会话发送的方案与本地操作演示。
- 本索引只列来源链接，不维护第二套任务进度。

## Tracker

- [[Spec] 可对话、受限执行、以 Issues 管理的任务工作流](https://github.com/luyigy/agent-platform-v2/issues/1)
- [[W1] 在任务话题中持续问答并补材料接续原任务](https://github.com/luyigy/agent-platform-v2/issues/2)
- [[W2] 在细化权限的本机沙箱中完成一次受控交付](https://github.com/luyigy/agent-platform-v2/issues/3)
- [[W3] 从 Spec 和 GitHub/Gitee Issues 在飞书生成路线提审](https://github.com/luyigy/agent-platform-v2/issues/4)
- [[W4] 按获批 Issues 关系自动集成、同步并接力](https://github.com/luyigy/agent-platform-v2/issues/5)
- [[W5] 导入 mold 与 Reader 既有结果并验证真实跨仓续跑](https://github.com/luyigy/agent-platform-v2/issues/6)

W1/W2/W3 无前置，W4 被三者阻塞，W5 被 W4 阻塞；GitHub 原生关系已回读核验。关系和实时进度在 Issues 管理，本文件仅是发布时的索引。

## 执行状态

本轮仅完成 Spec 与 tickets 发布，没有启动实施、分配执行 Harness 或修改现有业务路线。`ready-for-agent` 不代替飞书执行批准。

当前运行时尚未实现 W3 的从 Issues 自动提审，因此不伪造 ready 的 JSON 路线包，不宣称这组 Issues 已能直接启动整条新流程；W1/W2/W3 可在获批后先由现有执行能力实施，W4 再完成自动接力。
