---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/430_PLAN_20260815_多用户认证与WebUI配对接入.md
slice: S04
plan_progress: complete
---

# HANDOVER · 一次性PairingTicket与Runner配对接入闭环

## 完成内容

- 新增 `PairingTicket` 模型与迁移。登录用户生成 32 字节随机 Ticket，仅保存 SHA-256，10 分钟过期；新建时清理该用户未消费 Ticket。
- 新增鉴权 `POST /api/pairing-tickets` 与公开 `POST /api/runner/claim`。兑换事务先以 `consumedAt IS NULL AND expiresAt > now()` 原子消费，再创建继承 owner 的 `RemoteNode` 和独立 32 字节 Node Secret；重放、过期和无效 Ticket 均被拒绝。
- 新增公开 `/runner.js` 分发路由与侧栏“+ 接入我的本地电脑”弹窗，分别提供 Windows PowerShell 的 `curl.exe | node` 与 macOS/Linux 的 `curl | node` 命令；PowerShell 不使用会被解析为 `Invoke-WebRequest` 的 `curl` 别名。
- Runner 支持 `--pairing-token`、主机名登记、`~/.agent-platform/runner.json` 的 `0600` 持久化和无参数重连；仓库外下载执行时使用 Node 标准库 WS 兜底，不要求预装 npm 包。
- Remote Runner WebSocket 改为 `Authorization: Bearer <nodeSecret>`，不再把 Secret 放在 URL；公开 WS 地址可用 `REMOTE_RUNNER_PUBLIC_URL` 指向反向代理后的 `/runner` 服务。

## 验证

- `npm run test:pairing`
- `npm run test:auth-users`
- `npm run test:admin-users`
- `TS_NODE_BASEURL=. TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' node -r ts-node/register/transpile-only -r tsconfig-paths/register tests/resource-ownership.test.ts`
- `npx tsc --noEmit`
- `node --check scripts/agent-platform-runner.js`
- 仓库外 stdin 执行检查（验证无 `ws` 安装依赖）
- `npm run build`
- `npm run check:long-files`
- `git diff --check`

以上全部通过。生产构建收录 `/runner.js`、`/api/pairing-tickets` 和 `/api/runner/claim`；无达到 1000 行阻断阈值的文件。

## 验收入口

登录后点击侧栏“+ 接入我的本地电脑”，按目标电脑系统运行弹窗中的对应命令；Windows PowerShell 选择 `curl.exe` 命令，macOS/Linux 选择 `curl` 命令。平台部署需让 `REMOTE_RUNNER_PUBLIC_URL` 可访问 Remote Runner Gateway 的 `/runner` WebSocket 升级端点。

工作区仍有 5 个与本 PLAN 无关的既有修改，本次未暂存、未提交。
