# S02：M06 话题正常追问，内部重试不刷卡或启动业务

**What to build：** 用户问 M06 为什么失败，原角色 Agent 在原 Native Session 正常解释；
再补充信息时能接着交流。一条源消息的一位回答者只有一张回复卡，平台内部重试不新增卡。
仅询问和补充消息不被当成恢复实施的命令。

**Blocked by：** [S01](S01-manual-chat.md)，复用其明确的消息/卡片所有权边界。

**Status：** draft，未实施。

**仓库与基线：** `/data1/code/agent-platform-v2` @ `ebbce344249e7c270f6d7f4a2fdc681188c6375e`，叠加 S01 已验证提交；实际 HEAD 写入交接。

**默认环境画像：** [spec](../spec.md) 的平台环境，M06 已保存身份用于只读核对；完整路径先在隔离任务夹具运行。

## 验收项及验证命令

- [ ] “为什么失败”及连续追问进入原 Agent，而非平台生成的业务状态答复；验收者与实施者不串会话。
- [ ] 业务写入被阻塞时仍能正常回答；对话回复无需先获得 Reader 写占用、完成环境预检或重新派发实施。
- [ ] 同一输入模拟三次启动失败再成功，所有尝试复用同一回复身份和 message ID；下一条用户消息使用新卡。
- [ ] Agent 明确报告缺能力时，状态保留为真实阻塞；平台预检成功不会将它改成 continue_work。
- [ ] 询问不改变冻结候选、任务依赖或验收状态。明确继续的动作单独核验归属和用户授权，且最多派发一次。
- [ ] 失败原因明确区分启动前失败、工具失败和正式验收失败；晚到失败回执不覆盖下一轮卡片。

将真实询问→失败重试→原会话回答的链路补入以下回归，运行：

```bash
node scripts/sandbox-postgres-session.mjs run task-graph-conversation-target task-graph-conversation-delivery task-graph-feishu-relay task-graph-environment-outcome
npm run test:codex-app-server
npm run check:long-files
```

真人演示：M06 话题询问原因并追问，回读两张各自更新完成的卡、原 Native Session 和未改变的业务候选。
没有为演示要求用户重复授权或主动恢复实施。

## 保持不变与完成边界

沿用真实消息身份和回执；自动阶段内部重试也保持稳定阶段身份。
有写能力的实施 turn 与只交流的 turn 要有明确操作边界，不能靠自然语言猜是否会写，
也不能为聊天另建一个失去上下文的替身 Agent。原会话正在运行时按已有 steering/排队语义处理。
本票不解决 Reader 业务缺陷，也不声称 S03 的实际写入已恢复。
