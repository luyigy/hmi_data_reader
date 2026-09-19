---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: null
slice: hotfix
plan_progress: complete
---

# HANDOVER · 本地PiSteering在线验收与当前改动交接

## 完成与验收

本地 Live Room Pi 运行期间可以接收追加用户消息，在当前工具结束后的模型调用中处理，不必等待整轮结束再开启新任务。

在线验收依据为本房间提供的聊天记录与用户确认（北京时间 2026-09-19）：12:21:46 用户提出工具执行中追加消息测试，12:22:02 追加“输出一个 hello”，12:22:25 Pi 返回 hello 并报告在读取 steering 相关文件后的工具边界接收追加消息；12:25:48 用户明确确认测试成功并要求交接、提交。此结论是人工在线验收，本次收口未另行查询生产事件来复核同进程属性。

本轮仅整理交接、复跑验证与提交已有改动，未重启服务。当前工作独立于既有 PLAN；通过 workflow:new 的终态模板生成骨架后，将关联改为 plan: null / slice: hotfix，不冒充历史 PLAN 的新执行。next_action: none，不自动启动后续 Session。

## 实现入口与边界

- live-room-delivery.ts → live-room-steering.ts：仅本地 Pi 的合适用户消息进入 steering；启动时存在更早待投递消息则继续按队列顺序处理。斜杠命令、全员提及、强制路由和接力等不走此入口。
- live-room-delivery-execution.ts → acpx/runner-participant.ts → real-agents/pi-agent.ts：为本地 Pi 注册运行时回调，启用 RPC；workflow completion gate 执行不启用 steering，Codex 与远端适配器不改。
- live-room-process-registry.ts：校验 room、session、generation 和原始运行消息，避免 /new 或运行切换后投递到旧进程。
- real-agents/pi-rpc.ts：使用 prompt + streamingBehavior: steer，按消息 ID 去重；处理 agent_end 后重试、状态查询与结束时追加的竞争，并清理包装脚本及子进程组。
- 投递在写 stdin 前持久化 claim；accepted 记为 delivered（表示接收，不代表业务已完成）；rejected 回落排队；unknown 标失败、提示核对、不自动重发。

此前保留的四处工作区改动也依用户“提交当前更改”一并纳入：feishu-new-session.ts 及对应测试修复 /new profile 同步到成员、全量重置同步任务默认权限、定向或 rotatable-only 重置不影响排除成员；feishu-room-create-card.ts 及对应测试将 Agent 发现等待限制为 1 秒，慢发现使用缓存或提示稍后重试，降低飞书回调超时风险。这四处不是本轮新实现。

## 本次验证

以下检查全部通过：

- npm run test:pi-rpc：追加、去重、退出、重试、错误、空响应、超时、回执丢失。
- npm run test:live-room-steering：接收状态、排队回落、会话/代次/运行校验、清理与去重。
- npm run test:live-room-queue：既有执行队列回归。
- PI_RPC_NATIVE_BIN=/home/hello/.local/share/pnpm/pi npm run test:pi-rpc-native：真实 Pi 进程配本地模拟模型，验证两条消息各一次、同进程、真实 Bash 工具边界、持久会话续聊、结束竞争；共 6 次模拟模型调用，无外部模型请求。
- npm run test:new-session-rotation、npm run test:feishu-room-create-card：既有四处改动回归；后者的 catalog unavailable 日志为预期故障注入，测试通过。
- npx tsc --noEmit、npm run check:long-files、git diff --check。

文档暂存后执行 workflow:validate -- --preflight。初检提示 PROMPT_FORBIDDEN：终态 none 不允许自动化 Prompt；按校验要求移除标记后复检。

## 限制与后续

无验收阻塞。进程内注册与串行去重沿用当前本地执行队列的单进程所有权，不承诺跨平台服务进程并发去重。回执不明需人工核对，不能据此自动重发。原会话的 provider 上下文遥测缺失是诊断提示，此次未修复；本次成功也不代表 Codex 或远端 Runner 已支持 steering。后续若扩展协议，应单独立项并复用现有投递与边界测试。

## 提交文件

- package.json
- src/lib/acpx/types.ts、src/lib/acpx/runner-participant.ts
- src/lib/live-room-delivery.ts、src/lib/live-room-delivery-execution.ts、src/lib/live-room-process-registry.ts、src/lib/live-room-steering.ts
- src/lib/real-agents/pi-agent.ts、src/lib/real-agents/pi-rpc.ts
- tests/pi-rpc.test.ts、tests/pi-rpc-native.test.ts、tests/live-room-steering.test.ts
- src/lib/feishu-new-session.ts、tests/new-session-rotation.test.ts
- src/lib/feishu-room-create-card.ts、tests/feishu-room-create-card.test.ts
- 本 HANDOVER

后续会话先读取本交接与 `docs/workflow/workflow-contract.yaml`，等待新的明确任务，不自动扩展到 Codex 或远端 Runner。本终态交接按校验规则不含自动执行 Prompt。
