---
doc_type: PLAN
doc_status: ready
next_action: start_first_slice
plan_kind: phase
roadmap: null
parent_plan: null
parent_slice: null
return_to: null
---

# PLAN · LiveRoom远程执行超时Runner连接与Dashboard可见性修复

## 背景与已确认根因

本计划同时修复三个独立但在同一使用路径上暴露的问题：

1. `shaw-pi` 的 Remote SSH 回复命中固定 `600000ms` 上限。远程 SSH 与 Remote Runner
   都在 `src/lib/acpx/runner-harness.ts` 使用 10 分钟默认值，Live Room、飞书房间卡片及
   `/ap` 命令没有覆盖入口。
2. Live Room 把任何 `timed out after ...ms` 误判为续聊会话损坏，可能在第一次完整超时后
   再开启一次新会话；Codex adapter 也把墙钟超时列入了会话失效模式。与此同时，delivery
   回收逻辑仍硬编码 10 分 30 秒及 12 分钟，单独调大执行器超时会产生新的误回收。
3. Windows runner 的 pairing ticket 已兑换，但 3012 Remote Runner Gateway 未安装、未运行，
   且默认只绑定 `127.0.0.1`；runner 静默吞掉 WebSocket 连接错误，所以“已配对”看起来像
   “已接入”。`RemoteNode` 也没有 Dashboard 消费者。
4. Dashboard `AgentCard` 读取 `name`、`lastHeartbeat`，`/api/agents` 却返回
   `displayName` 且漏掉 `lastHeartbeat`，造成空标题和 `Invalid Date`。能力数组为空是上游确实
   未上报，不应伪造；远程 Agent 的陈旧心跳也不应继续显示在线。

## 目标与约束

- 房间级执行超时可从飞书创建/配置卡和 `/ap timeout <分钟>` 设置；既有房间未设置时保持
  当前行为（Platform Local 的既有长运行策略、远程默认 10 分钟）。显式配置后每轮执行继承。
- 墙钟执行超时只结束本次运行并给出准确提示，不标记 continuation stale，也不自动重跑。
- Remote Runner Gateway 随仓库 systemd 安装流程启动、可被远端访问；runner 明确区分
  “凭证已配对”“WebSocket 已连接”“连接失败并重试”。
- Dashboard 正确展示 Agent 字段、空能力和陈旧心跳，并以独立 Remote Runner 区域展示
  `RemoteNode`，不合并两套数据模型。
- 不增加依赖，不扩展新的 Runner 协议，不为能力数组编造默认值，不在本计划中重做 Dashboard。

## S01：执行超时配置与重试语义

### 实施范围

1. 为 `LiveRoom` 增加可空的 `executionTimeoutMs` 及 Prisma migration。`null` 表示沿用现有
   backend 默认策略；显式值统一限制为 1–1440 分钟并在服务端转换为毫秒，拒绝 NaN、负数、
   小数和越界值。
2. 在飞书房间创建/配置卡加入“执行超时（分钟）”输入；表单解析为 `/ap room --timeout=...`。
   已绑定房间由 room 命令更新该字段。新增 `/ap timeout <分钟>` 作为已有房间的短路径，两个
   入口复用同一校验/更新函数，并在结果中回显最终分钟数。
3. `runLiveRoomAcpxAttempt` 从 room 读取显式配置并写入 `watchdogConfig.maxRuntimeMs`；没有显式
   配置时不覆盖 `runner-harness` 的当前本地/远程默认值。Remote SSH 与 Remote Runner 必须走
   同一解析结果。
4. 删除 Live Room 对通用 `timed out after ...ms` 的 fresh-session fallback，并从 adapter 的
   continuation-invalid 模式中移除纯墙钟超时。只保留明确的 session/thread 不存在、无效或连接
   损坏信号。超时后的系统提示写成“执行超时”，不得写“续聊会话失效”。
5. 将 `live-room-delivery-processing.ts` 与 `feishu-runtime-cleanup.ts` 的硬编码回收阈值改为
   “该 delivery 所属房间的有效执行超时 + 宽限时间”；仍有注册进程的运行不得仅因超过旧的
   10/12 分钟阈值被回收。

### 验证与完成标准

- 新增一个聚焦测试覆盖：`null` 保持远程 10 分钟默认、显式 30/60/自定义分钟能传到两种远程
  executor、越界值被拒绝。
- 飞书卡片/表单/命令测试覆盖创建房间与既有房间更新，并断言结果回显。
- continuation 回归测试断言：明确 session-not-found 只重试一次；Remote SSH/Runner 的
  `timed out after 600000ms` 不重试、不标 stale。
- stale-delivery 测试断言 30 分钟配置不会在 10/12 分钟被回收，超过“配置值 + grace”才回收。
- 运行相关测试、`npx tsc --noEmit`、`npm run check:long-files`、`git diff --check`。

## S02：Remote Runner Gateway 部署与连接可诊断性

### 实施范围

1. 把 `agent-platform-remote-runner-gateway.service` 加入
   `scripts/install-systemd-user-services.sh` 的安装、enable/start 和输出清单。
2. unit 显式设置 `REMOTE_RUNNER_GATEWAY_HOST=0.0.0.0`，继续使用 token 鉴权和默认 3012；
   `REMOTE_RUNNER_PUBLIC_URL` 仍由平台环境配置，不新增第二套配置文件。
3. runner 在 claim 成功时只打印“paired”；收到 `welcome` 后打印“connected”。WebSocket
   error/close 至少打印 endpoint、错误原因和下次重试时间，成功重连后恢复简洁输出，避免连接
   失败继续静默。
4. 保持现有指数退避、心跳、凭证文件和协议不变；不新增守护进程或日志框架。

### 验证与完成标准

- 静态回归检查 unit 被安装且监听地址可远程访问；runner 测试覆盖“paired 但连接失败”和
  `welcome` 后 connected 两种可观察状态。
- 部署验收：重新运行安装脚本后 service 为 `active`，`:3012` 监听，`GET /health` 返回 200。
- Windows runner 重启后终端出现 connected；`/api/remote-nodes` 中目标节点为 online，且
  `host`、`lastSeen`、`metadata.harnesses/workspace` 已更新；Live Room agent 选择目录出现
  `<node> / Pi Agent Runner`。
- 从该 Runner 执行一个短 Pi Agent 回合，确认 stdout/stderr、completion 和 sessionDir 回传。

## S03：Dashboard Agent 契约与 Remote Runner 可见性

### 实施范围

1. 固定 `/api/agents` 的响应契约：提供卡片所需的显示名和 ISO `lastHeartbeat`，同时保留现有
   `displayName` 等消费者字段，避免破坏 `/agents`、`/tasks` 和创建表单。以契约测试锁定字段。
2. Dashboard 对缺失时间显示“从未心跳/未知”，对空 capabilities 显示“未上报”，不再渲染
   空白区域或 `Invalid Date`。
3. 远程 Gateway Agent 的有效状态按已存状态与心跳新鲜度共同计算；以 30 秒 heartbeat 的
   3 个周期（90 秒）为初始离线阈值，并在测试中固定。Platform Local 在没有真实心跳源前保留
   当前状态语义，避免用 Dashboard GET 伪造健康检查。
4. Dashboard 直接请求现有 `/api/remote-nodes`，增加独立“Remote Runners”状态区，展示
   name、online/offline、host、lastSeen、harnesses 和 workspace；`lastSeen=null` 显示“从未连接”。
   扩展现有 API 返回必要的非敏感 metadata，绝不返回 secret/hash。

### 验证与完成标准

- API 契约测试覆盖 Agent 标题、心跳、90 秒陈旧状态及 capabilities 空数组。
- RemoteNode API/组件测试覆盖 online、offline、从未连接和 metadata 缺失；鉴权与 owner 过滤
  保持现有行为。
- Dashboard 浏览器验收：Agent 无空标题/`Invalid Date`，陈旧远程 Agent 不显示在线，
  `ww-ce250bc4`（或本轮实际节点）在 Remote Runners 区正确显示连接状态。
- 运行受影响测试、`npx tsc --noEmit`、`npm run build`、`npm run check:long-files`、
  `git diff --check`。

## 顺序、风险与回退

- 严格按 S01 → S02 → S03：先保证超时不会重复执行，再开放 Runner 服务，最后修展示与状态。
- S01 为 HIGH 风险主执行链变更；每个 Slice 单独提交并产出 HANDOVER，禁止 amend/rebase/reset。
- migration 只增加可空字段，回退代码时旧数据可保留；systemd 回退只需 disable 新 unit；
  Dashboard 回退不影响 Runner 执行链。
- 真实部署/重启只在 S02 代码与测试通过后执行；不得在未确认 3012 访问边界时开放额外端口。

<!-- WORKFLOW_PROMPT_START -->
执行 `docs/444_PLAN_20260817_LiveRoom远程执行超时Runner连接与Dashboard可见性修复.md` 的 S01；读取目标 HEAD 的 `AGENTS.md`、
`docs/workflow/workflow-contract.yaml` 和本 PLAN。完成验证、创建下一 HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
