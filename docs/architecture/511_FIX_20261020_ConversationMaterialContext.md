---
doc_type: FIX
doc_status: completed
---

# R05 引用前几轮材料时误报无恢复权限

基线 `2cc5553`。上一轮修复让聊天答复出现在卡片首屏，但未改变材料接续的限制。

## 本次真实失败

2026-10-20 15:17，用户在 R05 话题说“既然误会澄清了，那你继续实施啊”。Agent 已输出接续请求，引用此前补图和澄清消息。15:18 平台却回答“本批消息包含没有任务恢复权限的发言”。

两条引用均存在于同一 execution 的 `conversation_input` 账本中；它们只是已经被前几轮消费，不再属于当前 `pending` 批次。现场见 [case.json](../evidence/conversation-material-context/case.json)。

原代码 `pending.find(id)` 只能解析本轮输入，解析失败直接令 `authorized = false`。材料身份与操作者权限被混为同一布尔值，因此把有效历史材料误报成无权限。Agent 同时受到“只解释进度、回答问题”和旧失败快照的强提示，难以根据新证据纠正判断。纯控制行又被卡片全部隐藏，用户看到“本轮没有文字答复”。

## 修复

- 引用材料从持久会话事件核对，必须同时满足同 run、node、execution 和 `conversation_input` 类型，最多 50 个不同引用。当前批次与已处理的历史材料均可引用，不要求搬图或重发。
- 本轮操作者权限仍按原管理员/任务拥有者规则核验。历史材料不授予权限；来源不匹配与无权限分别报告。writer 退出、候选、revision、预算和阶段门禁仍由原交接路径核验。
- Agent 的指令明确要求正常回答、结合前几轮证据并纠正旧判断；需要实施时说明下一步，再附加接续请求。写入仍在 writer 交接后发生，聊天不能直接更改验收结论。
- 兼容纯控制行的旧回复：显示执行者提供的接续依据，不再显示空答复；说明不代表平台已经恢复或验收通过。

没有增加自然语言关键词分类器，没有取消 sandbox、另开并发写入者或重置旧运行预算。

## 回归证据

扩展原 interactive-conversation 回归，按真实顺序先提交材料并完成问答，再由有权限的当前用户要求继续，Agent 引用前轮材料。

- 修改前 exit 1，`implementation_recovery_scheduled = 0`，预期为 1；[红日志](../evidence/conversation-material-context/red.log)。
- 修改后 exit 0，安排一次接续并在原 native 会话完成实施，原实施轮数为 2；无权限材料批次仍被拒绝，兄弟的权限暂停不被放行，恢复不消耗 repair 预算；[绿日志](../evidence/conversation-material-context/green.log)。
- reply-summary、failure-summary、TypeScript、长文件与差异空白检查通过。

测试使用隔离 worktree、runner 临时 PostgreSQL schema 和原有模型替身。writer、Git 和实际任务状态转换使用原实现。线上只核对现场、部署修复及刷新答复投影，不直接重放已失败的业务恢复请求。

## 边界

本次解决材料跨轮引用失败和指令限制，不代表完整的任务会话架构已重构。实施仍须通过既有单 writer 交接；已验收成果、预算耗尽、权限扩大和真正缺失的材料不自动放行。
