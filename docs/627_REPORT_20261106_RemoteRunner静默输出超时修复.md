# Remote Runner 静默输出超时修复

## 结论与范围

用户在 Feishu DM 08a216 要求调查群 `oc_bb599d4608ff895a5dfae3d1fb49107a` 的 desktop-78hk9dd-b2ea3685 Pi Agent 反复 `terminated`，随后明确“直接修复”。源码提交 `481b79d`，基线 `372bbb5`；在隔离工作树 `/data1/code/agent-platform-runner-heartbeat` 验证后 fast-forward 合入 `oss-prep`。

Runner 网关现在立即发送一条传输心跳，随后每 15 秒发送一次，防止长时间静默工具触发 HTTP 等待超时。心跳不会作为 Agent 输出或业务进展，不改变房间总执行时限，不自动重跑失败任务。任务结束、失败或客户端断开时清理定时器；仍在执行时断开继续发送一次取消指令，已经失败返回的请求不再额外发送取消。

没有修改 Windows Runner、业务仓、数据库结构、watcher cursor、审批或任务图状态。本记录不表示此前沙箱问题已解决。

## 诊断证据

以下为 2026-11-06 北京时间：

| TaskRun | 最后输出 | 失败 | 静默间隔 |
| --- | --- | --- | --- |
| cmw4jbua70emwpwhjk0lh1f3b | 13:33:24.374 | 13:38:24.975 | 300.601 秒 |
| cmw4jptv10ewnpwhj2066s6oi | 13:40:53.845 | 13:45:54.444 | 300.599 秒 |

两次均在 `docker compose build … | tail …` 后静默，两条 TaskRun 的 watchdogConfig 都是 `maxRuntimeMs=3600000`，controlState=normal。房间 executionTimeoutMs=3600000，13:35:55 的 timeout 命令成功落库。因此不是 60 分钟设置失效。

平台执行器使用 Node 内置 fetch 读取网关 NDJSON。运行环境 Node v22.22.1 内置 Undici 的默认 bodyTimeout 为 300000ms，输出流超时会抛出 TypeError `terminated`，cause 为 `UND_ERR_BODY_TIMEOUT`。旧网关只在远端 stdout/stderr/complete 时写入 HTTP 响应；WebSocket 节点心跳和飞书卡片心跳没有写入这条响应。客户端断开又会触发网关 cancelNodeRun。

历史账本仅保存 error.message，没有原始 cause；上述现场归因由精确时间吻合、实际源码和隔离复现共同支持，不能声称已取回历史异常堆栈。隔离测试使用真实网关入口及真实 fetch，将 HTTP 等待时限和心跳间隔缩短，远端执行边界使用替身；未调用模型、数据库写入或远端部署。修复前真实失败为 `terminated / UND_ERR_BODY_TIMEOUT`。

## 修改

- `scripts/remote-runner-gateway.ts`：立即及定时传输心跳，完成/异常/断连清理，避免对关闭响应继续写入，完成失败后的 close 不再重复取消。
- `src/lib/remote-harness/runner-executor.ts`：保留主动停止与总时限的原始原因；将原生 body/header timeout 和连接错误码转为具体可读错误，不展示底层 socket 等敏感细节。已有 provider 错误继续保留。
- `tests/remote-runner-stream.test.ts`：执行真实网关 HTTP 请求，覆盖有初始输出后静默、从开始即静默、正常完成、provider 失败、节点离线、任务期限、主动取消、定时器清理和原生连接错误。

## 验证

通过以下测试与静态检查：

- 新增 remote-runner-stream 回归：静默任务跨过加速后的 HTTP body/header 等待期限；心跳不污染输出；总超时和停止各取消一次；body/header timeout、socket close 的底层错误码保留。
- `tests/remote-runner-executor.test.ts`：现有流解析、分片、去重、provider 错误和恢复。
- `tests/remote-runner-gateway-deployment.test.ts`：Runner 连接失败重试、重连、原生会话大小和 workspace 行为。
- `npm run test:live-room-execution-timeout`、`npm run test:feishu-room-timeout`。
- `npx tsc --noEmit --incremental false`、三个改动代码文件 ESLint、长文件守卫、`git diff --check`。

独立 TS 测试命令前缀：`TS_NODE_BASEURL=. TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' node -r ts-node/register/transpile-only -r tsconfig-paths/register`。

GitNexus upstream impact 定位直接调用 executeViaRemoteSshHarness，向上到 executeParticipant/executeAcpxTaskRun，风险 low。集成后 compare 差分也为 low；差分索引没有完整列出执行器 catch 变更，人工核对实际调用路径，并用上述行为测试补足。没有对真实生产构建进行重放，真实长任务仍待下一次正常执行观察。

## 生效状态与接续

13:57:48 重载 `agent-platform-remote-runner-gateway.service`。重载前确认没有 pending/running/waiting_for_input 的 remote-node TaskRun，也没有该类成员 pending/running 投递。健康检查 `/health` 返回 `{"ok":true}`，服务 active。

13:57:49 两台节点 desktop-78hk9dd-b2ea3685 和 desktop-5cn8jha-a08556ec 均重新上报 online/lastSeen，已经自动重连，无需重新 curl，也不需要重新配对。若用户日后主动退出 Runner，用原有有效启动方式启动即可；启动连接不代表重跑任务。

**防止静默断开的网关修复已经生效。更详细的失败提示尚待飞书主服务重启加载。** 核查时飞书主进程仍承载两个本机 Codex 任务，因此没有重启，沿用用户自行重启的既有约定。任务结束后可执行：

```bash
systemctl --user restart agent-platform-feishu.service
```

未重跑 `docker compose build`、未推送或部署 tb-feishu-alarm 业务代码。该业务任务后续接续应先核对真实构建、容器与 Git 状态，不能将本次平台修复当成业务部署成功的证据。
