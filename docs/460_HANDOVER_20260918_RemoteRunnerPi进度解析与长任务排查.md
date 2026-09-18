---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: null
slice: hotfix
plan_progress: complete
---

# HANDOVER · RemoteRunnerPi进度解析与长任务排查

## 结论与证据

2026-09-18「机台数据采集」群的 desktop-78hk9dd-b2ea3685 使用 Remote Runner，不是 SSH；因此此前 SSH PowerShell 修复不覆盖此问题。

- 16:30:04–16:30:19 的 hello 正常完成，证明并非始终无响应。
- 16:33:09–16:42:07 的运行 `cmu6pb6lk000bw5dy6fpfd0pd` 持续操作 Mosquitto 配置、Windows 服务与计划任务、MQTT 连接测试，之后被用户停止；不是等待用户输入或无活动挂起。
- 持久事件含 2151 个 stdout chunk、28 次工具调用（28 次结束，其中 4 次工具报错）、13 条 assistant 正文；原始 usage/toolcall 更新大量占据进度展示。
- 用户此轮要求说明当前架构、把编码交给 antigravity，但代理继续了前一轮的 Mosquitto 修复。属于执行偏离当前要求；没有证据表明增加超时可解决。此次不修改远端 Mosquitto，也不恢复已停止的任务。

## 根因与修复

Runner 脚本将 Pi JSON stdout 经 WebSocket → gateway NDJSON 原样送到 runner-executor；后者把整个原始 chunk 交给 onStdoutChunk，飞书将其当成思考摘要，工具也没有进入 onToolEvent。

- 导出并复用 SSH 已有的 processPiJsonLine：只转发完成的 assistant 文本和工具开始事件，忽略 usage、内部 thinking、工具原始结果等 JSON 事件。
- Runner 按行缓冲 Pi stdout；HTTP 使用流式 UTF-8 解码，处理跨 frame/跨字节拆包与末尾无换行。
- 使用既有 sanitizePreview 脱敏与限制摘要长度，合并 message_end/turn_end 的重复正文；最终回复继续使用 Runner complete.output。
- 不新增依赖，不修改 Runner 协议或远端脚本，不改变任务超时、会话续接和远端业务配置。

## 验证

以下检查均通过。

- remote-runner-executor 回归：正文/工具解析、重复正文过滤、敏感值脱敏、内部事件过滤、Pi 行拆包、中文 UTF-8 字节拆包、无换行尾帧。
- remote-ssh-pi-progress 回归，保证复用解析器不破坏 SSH 行为。
- 对历史 2151 个 stdout chunk 做本机离线回放，通过，还原 13 条正文摘要与 28 次工具进度；不发送远端任务。
- npx tsc --noEmit、check:long-files、git diff --check 及文档 preflight。

## 部署与下一步

代码验证后仍需飞书后台加载新代码；本次未重启承载当前回复的服务，未更新远端 Runner。空闲时执行 `systemctl --user restart agent-platform-feishu.service`，在群中验收下一轮 Pi 的工具列表及可读正文。

对业务任务偏离，下一轮明确限定“只读现状、禁止改配置/重启服务，先回复核对结果，再交接 antigravity”；若旧会话继续执着于旧目标，再使用现有新会话入口。不能把本次显示修复说成已解决模型执行偏离。

## 修改文件

- src/lib/remote-harness/runner-executor.ts
- src/lib/remote-harness/ssh-executor.ts（仅导出既有解析器）
- tests/remote-runner-executor.test.ts
- 本 HANDOVER；独立 hotfix，终态记录，不启动工作流。
