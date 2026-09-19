---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: null
slice: hotfix
plan_progress: complete
---

# HANDOVER · 本地CodexLiveRoomSteering实现与验证交接

## 完成结果与范围

已实现 platform_local Codex 的 Live Room steering。普通追加用户消息可以通过当前 app-server 的 turn/steer 送入活跃 turn，不必等原任务完成后另开执行。复用 HarnessSteer、运行时注册表、LiveRoomDelivery claim 与去重；未新建队列或框架，未修改数据库结构。Pi RPC 与远端 Runner 实现未改。

开工分支为 oss-prep，HEAD 为 62dfa67，工作区干净；初始长文件守卫通过。读取 AGENTS、462 交接、合同、写作标准和两个模板。本交接使用 workflow:new 的终态模板生成骨架；生成器要求 PLAN 参数，因此使用 448 的单 Slice 模板入口，随后明确改为 plan: null / slice: hotfix。本任务来自用户直接实施指令，不属于历史 448 PLAN，未触发审批或新 Session。

## 实现与生命周期

- live-room-delivery → live-room-steering：原本仅本地 Pi 的入口扩展到本地 Codex，共享函数改为 dispatchLocalSteeringOnce / trySteerLocalMember。保留用户来源、斜杠命令、强制路由、全员提及、接力筛选；启动窗口有更早 pending 消息时按原队列处理。
- live-room-delivery-execution → acpx/runner-participant → runner-harness → harness/adapters/codex → codex-agent → codex-app-server：传递现有 onSteeringReady；房间执行层及 participant 层均排除 workflowCompletionGate；本地 Codex 执行和恢复在该回调存在时使用 app-server，普通非 steering 调用保持原选择条件。
- thread/start 或 thread/resume 获取 threadId；turn/start 响应或同 thread 的 turn/started 获取 turnId 后注册。turn/steer 携带 threadId、expectedTurnId 和文本输入。不同 thread/turn 的完成通知不能关闭本次注册；完成、失败、进程退出和 finally 清理注册。子进程已被 kill 时不再投递。
- 继续使用 room/session/generation/runMessageId 校验；追加消息 ID 共用同一个回执 Promise，不重复写 stdin，按调用顺序写入。持久化 running claim 在写入之前，accepted 标记 delivered 仅代表接收；明确 JSON-RPC 错误才 rejected 并回落排队；超时、断连、回执缺失/ID 不符为 unknown，标失败且不自动重发。
- steering 请求 5 秒回执超时，其他 app-server 请求 30 秒超时；总体执行超时及停止会解除挂起请求。结束竞争不通过 turn/start 重试追加消息；只会明确拒绝或回执不明。
- app-server 启动阶段失败且未提交原始 turn 时，沿用原有允许条件回退 exec/json（受限 workspace 仍禁止该降级）；JSON 路径不注册 steering，消息正常排队。turn/start 一经尝试或子进程已被主动停止，禁止 JSON 重跑原任务。旧版本仅不支持 turn/steer 时返回明确错误，追加消息排队，原任务继续。
- 保留 Bubblewrap、审批处理、模型/effort、输出与额度/token 遥测；app-server thread 配置显式传递 workspace-write 网络设置，使 never 审批运行切换通道后仍遵守 networkAccess。修正 Error 派生类原型，使仓库默认 TypeScript 编译目标下的错误分类和安全回退判断有效。
- 新增不含正文的 Codex steering 诊断，记录 messageId/threadId/turnId/status，经原有 stderr 事件链持久化，便于在线核对。

GitNexus 已刷新索引并执行 upstream impact、processes 阅读和 detect_changes；Codex 直接调用者为 executeCodexCLI / resumeCodexSession，共享投递影响飞书、Web 消息及 workflow 入口。图分析将共享入口标为高风险，因此增加真实入口边界测试，并保留原权限、路由及 completion gate 行为。图结果仅辅助实际代码链阅读。

## 验证结果

模拟协议/持久化边界测试：

- npm run test:codex-app-server：新建/恢复、审批、隔离、遥测、结束、超时、停止及安全回退通过；测试完成通知更新为实际协议中的 threadId/turnId。
- npm run test:codex-steering：成功注入、两条消息顺序、同 ID 去重、foreign completion、明确拒绝、不支持方法、结束竞争、空/错误 ID 回执、丢回执、5 秒回执超时、退出、主动停止、恢复及 JSON 不重复执行通过。故障注入中的 Execution failed 日志是预期。
- npm run test:live-room-steering：持久化 claim、accepted/rejected/unknown、旧 room/session/generation/runMessageId 拒绝、旧清理不删除新注册、启动窗口顺序、持久化去重通过；调用真实 triggerLiveRoomAgentReply 验证 Codex 注入及斜杠/强制路由/接力/workflow 来源/非用户/其他 harness/远端排除。
- npm run test:pi-rpc、npm run test:live-room-queue、npm run test:workflow-completion-gate，以及直接运行 tests/live-room-workflows.test.ts 通过。
- PI_RPC_NATIVE_BIN=/home/hello/.local/share/pnpm/pi npm run test:pi-rpc-native 通过：真实 Pi 配本地模拟模型，共 6 次模型调用，包含同进程、顺序、去重、持久会话和结束竞争。
- npx tsc --noEmit、npm run check:long-files、git diff --check 通过，无达到 1000 行的文件。

真实 Codex 进程测试（模型为本地 Responses API 桩，不是在线模型或飞书验收）：

执行 `CODEX_STEERING_NATIVE=1 npm run test:codex-steering-native`，使用独立临时 CODEX_HOME 与 loopback provider，无外部模型请求。本机 `codex --version` 为 `codex-cli 0.153.2`；实际 `generate-ts` 类型确认 turn/steer 的 expectedTurnId 必填、回执含 turnId。

一次实测记录：threadId=`01a0b7fb-5c3c-7613-beb0-afe060f4fe46`，turnId=`01a0b7fb-5c81-7dd1-82d2-1a3e49054bf3`。只有一个进程、一个 turn/started 和对应 turn/completed；真实 shell 执行 sleep 0.3 时追加 FIRST、SECOND 和 FIRST 重复消息，两个唯一输入均 accepted。第一次模型请求没有追加输入，第二次请求在工具执行后包含各一条 FIRST/SECOND，顺序正确；共两次模型请求。断言依据来自模型请求体和协议通知，不依据模型说自己收到了什么。这里验证的是该工具场景的时机，不承诺打断已经发出的推理/HTTP 请求，也不推断所有 Codex 模式都具有相同时机。

官方依据：[Codex app-server](https://learn.chatgpt.com/docs/app-server)：turn/steer 追加到活跃 turn，expectedTurnId 必须匹配；无活跃 turn 时失败，不发出新的 turn/started。官方说明与本机协议、真实进程测试分别核对。

## 飞书在线验收：待在线验收

1. 当前任务结束、确认没有需保留的活跃运行后，重启用户服务 `systemctl --user restart agent-platform-feishu.service`，使飞书入口加载代码。此次未重启；重启会短暂断开飞书连接并可能中断其当前任务。该服务的 ExecStart 指向仓库 scripts/run-feishu-runtime.sh。Web 入口若需验证，也须按其现有部署流程重新加载代码。
2. 在飞书 Live Room 选择 platform_local Codex，发一个可观察的工具任务，例如“执行 sleep 15，完成后读取 package.json 并汇总”，等待工具运行后追加普通消息“输出 hello”。不要使用斜杠命令、全员提及或强制路由。
3. 核对接收提示；在原 taskRun 的 stderr 事件查找 `Codex steering:`，保存追加 messageId、threadId、turnId、status=accepted。核对原任务的 Codex thread/turn（可结合 Codex rollout 或协议记录）与该回执一致；不能仅以模型自述作为证据。
4. 追加消息的 LiveRoomDelivery 应只有一条 delivered，fallbackReason 关联原 runMessageId；同一任务回复应处理 hello，不能为该消息新增 participant/taskRun，不能出现额外排队执行或重复业务回复。接收提示是系统回执，不计为业务回复。
5. 原任务完成后再发普通消息应正常开启后续任务。补查 /new、停止、启动窗口、workflow gate 和远端路径仍按其原边界工作。

## 限制与交付状态

实现和本地验证完成；飞书在线验收待进行，不能将本地模型桩测试写成生产验收通过。进程内注册与去重沿用既有单进程执行所有权，不保证多个平台服务并发消费时的跨进程去重。unknown 必须人工核对；accepted 也不保证业务已完成。未重启生产服务，未启用或调整 watcher、未改写 Git 历史。

文档动作 await_acceptance 是终态，不自动派发下一 Session，不包含自动执行 Prompt；暂存后运行 workflow:validate -- --preflight。

修改文件：package.json；src/lib/acpx/runner-participant.ts；src/lib/live-room-delivery.ts；src/lib/live-room-delivery-execution.ts；src/lib/live-room-steering.ts；src/lib/real-agents/codex-agent.ts；src/lib/real-agents/codex-app-server.ts；src/lib/real-agents/codex-app-server.test.ts；tests/live-room-steering.test.ts；tests/codex-steering.test.ts；tests/codex-steering-native.test.ts；本交接文档。
