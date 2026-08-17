---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/444_PLAN_20260817_LiveRoom远程执行超时Runner连接与Dashboard可见性修复.md
slice: S02
plan_progress: in_progress
---

# HANDOVER · RemoteRunnerGateway部署与Runner连接诊断交付

## 完成内容

1. **systemd 安装流程纳入 Gateway**：`scripts/install-systemd-user-services.sh` 现在安装、
   `enable --now` 并在输出清单中列出 `agent-platform-remote-runner-gateway.service`。
   unit 新增 `Environment=REMOTE_RUNNER_GATEWAY_HOST=0.0.0.0`（沿用 token 鉴权与默认 3012，
   `REMOTE_RUNNER_PUBLIC_URL` 仍由平台环境配置，未新增第二套配置文件）。
2. **runner 可观察状态**：`scripts/agent-platform-runner.js` claim 成功只打印 `paired`，
   收到网关 `welcome` 后打印 `connected`。WebSocket `error` 打印 endpoint 与错误原因，
   `close` 打印 endpoint 与下次重试延迟（如 `retrying in 1000ms`）；连接健康时保持简洁输出。
3. **修复静默退出极障**：重连定时器原先 `.unref()`，首次连接失败后进程直接退出、
   指数退避从未真正发生（“已配对”看起来像“已接入”的根因之一）。现在重连 timer 保持引用，
   退避节奏（1s→2s→…→30s 封顶）与心跳/凭证文件/协议均不变。内置 fallback WebSocket 实现的
   `close()` 在握手未完成时补发 `close` 事件，保证无 `ws` 包环境下也能重连。
4. **部署验收（本机 shaw-pi）**：重跑安装脚本后 `agent-platform-remote-runner-gateway.service`
   `active`，网关日志 `listening on 0.0.0.0:3012`，`GET /health` 返回 200（loopback 与
   192.168.31.109 双验证）。既有 dev/feishu/scheduled-jobs 服务未被重启。
5. **端到端自验收**：注册临时节点 `s02-selftest` 启动真实 runner → 终端输出 `connected`；
   DB 中该节点 `online`，`host=127.0.0.1`、`lastSeen`、`metadata.harnesses=['pi-agent']`、
   `metadata.workspace` 均更新；harness options 出现 `s02-selftest / Pi Agent Runner`（status=online）；
   经网关 `POST /run` 执行短 Pi Agent 回合，stdout 流式回传、`complete success=true`、
   `output=pong`、`sessionDir` 回传；runner 停止后节点自动转 `offline`。测试节点与临时目录已清理。

## 修改文件

- `deploy/systemd-user/agent-platform-remote-runner-gateway.service`
- `scripts/install-systemd-user-services.sh`
- `scripts/agent-platform-runner.js`
- `tests/remote-runner-gateway-deployment.test.ts`（新增）
- `package.json`（新增 `test:remote-runner-deployment`）

## 验证

- `npm run test:remote-runner-deployment`：静态断言（安装/enable/清单三处包含 gateway unit、
  unit 绑定 `0.0.0.0`、网关源码保留 `REMOTE_RUNNER_GATEWAY_HOST` 钩子与默认 3012）+ 两种 runner
  可观察状态（claim 成功但 endpoint 不可达：`paired` + `connection to … failed: connect
  ECONNREFUSED` + `closed; retrying in 1000/2000ms`（验证退避翻倍）且无 `connected`；
  `welcome` 后：恰好输出 `connected`、hello 携带 node/harnesses/workspace、stderr 保持为空）+
  凭证文件内容不变（server/node/token/workspace）。
- 部署验收见上：service `active`、`0.0.0.0:3012` 监听、`/health` 200、网关日志正常。
- 回归：`test:remote-node-ws`、`tests/remote-runner-executor.test.ts`、`test:pairing`、
  `test:acpx-harness-options`、`tests/acpx-session-tracking.test.ts`、`test:git-history-guard`、
  `test:workflow-validator`、`test:workflow-completion-gate` 全部通过。
- `npx tsc --noEmit`、`npm run check:long-files`、`git diff --check` 通过。

## 遗留事项

- Windows runner（`ww-ce250bc4`，凭证已兑换）仍在旧脚本下运行过：旧脚本首次连接失败即退出，
  需在 Windows 机器上重新下载 `/runner.js`（或用新脚本重启）——新脚本会持续重连（≤30s）并打印
  `paired`/错误/`connected`。网关已就绪，等 runner 重启后即可验收：`/api/remote-nodes` 目标节点
  online、`host/lastSeen/metadata` 更新、Live Room 选择目录出现 `<node> / Pi Agent Runner`、
  从该 Runner 执行短回合回传 stdout/completion/sessionDir（本机 `s02-selftest` 已验证同一路径）。
- S03（Dashboard Agent 契约与 RemoteNode 可见性）未开始。
- S01 遗留的“真机长超时实测”仍待 Windows runner 重启后一并验收。

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/446_HANDOVER_20260817_RemoteRunnerGateway部署与Runner连接诊断交付.md`、`docs/444_PLAN_20260817_LiveRoom远程执行超时Runner连接与Dashboard可见性修复.md` 和 `docs/workflow/workflow-contract.yaml`，只执行 S03。
完成验证、创建下一 HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
