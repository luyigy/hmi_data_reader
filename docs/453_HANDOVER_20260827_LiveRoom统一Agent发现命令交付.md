---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: docs/444_PLAN_20260817_LiveRoom远程执行超时Runner连接与Dashboard可见性修复.md
slice: S03
plan_progress: complete
---

# HANDOVER · LiveRoom统一Agent发现命令交付

## 完成内容

1. 新增 `/ap discover-agents [gatewayId]`，旧 `/ap agents` 保持兼容；两者共用
   `listLiveRoomCatalogAgents()`，统一发现 Platform Local、Gateway、Remote SSH 与 Remote Runner，
   不再从仅覆盖部分来源的 `Agent` 表拼第二套目录。
2. 发现结果展示在线状态、执行后端、Gateway，并直接给出可复制的
   `/ap add --agents=<selector>`。
3. `/ap menu` 首页与“运行控制”分类均新增“发现 Agents”按钮，帮助页同步更新。
4. 实机目录已发现 Windows Runner `ww-16bd352b`，可添加 selector 为
   `remote_ssh:remote-node:ww-16bd352b:pi-agent`；用户已验收命令添加成功。

## 修改文件

- `src/lib/feishu-command-parser.ts`
- `src/lib/feishu-help.ts`
- `src/lib/feishu-runtime-commands.ts`
- `src/lib/feishu.ts`
- `tests/feishu-help-command.test.ts`
- `tests/feishu-agent-discovery-command.test.ts`

## 验证

- `TS_NODE_BASEURL=. TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' node -r ts-node/register/transpile-only -r tsconfig-paths/register tests/feishu-help-command.test.ts`
- `TS_NODE_BASEURL=. TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' node -r ts-node/register/transpile-only -r tsconfig-paths/register tests/feishu-agent-discovery-command.test.ts`
- `npx tsc --noEmit`
- `npm run check:long-files`
- `git diff --check`

## 后续问题

Windows Runner 被加入房间后，收到回复任务时在 `spawnPi()` 启动 PowerShell 处报
`spawn ENAMETOOLONG`。Runner 已成功 `connected`，因此配对、WebSocket 与 selector 路由正常；
故障范围收敛到 Windows Pi 启动命令。后续修复应检查 `-EncodedCommand` 把完整 prompt 编入
进程参数导致 Windows 命令行长度上限的问题，并在 `tests/remote-runner-gateway-deployment.test.ts`
留下可执行回归；修改 `/runner.js` 后目标 Windows 进程必须停止旧 Runner 并重新下载启动。

## 2026-08-27 Windows Runner `ENAMETOOLONG` 增补修复

- 根因确认：`spawnPi()` 将包括完整 prompt 在内的所有参数先逐项 UTF-8 Base64，再把整个
  PowerShell 脚本转为 UTF-16LE Base64 传入 `-EncodedCommand`；回复上下文较长时，膨胀后的
  PowerShell 进程参数在 Pi 启动前即超过 Windows 命令行长度上限。
- 修复：Windows 分支把 prompt 写入系统临时目录，通过 Pi CLI 原生 `@file` 参数读取；原有
  逐参数编码与显式 `string[]` 继续保留，短参数仍不会折叠。子进程退出、异步 error 或同步
  spawn 失败都会删除临时目录。
- 保护：同步 spawn 失败现在只向 Gateway 回传当前 run 的失败 completion，不再杀死常驻
  Runner 进程。
- 回归通过：`npm run test:remote-runner-deployment`、`node --check scripts/agent-platform-runner.js`、
  `npx tsc --noEmit`、`npm run check:long-files`、`git diff --check`。
- Windows 验收方式：停止当前旧 Runner，重新执行
  `curl.exe -fsSL http://10.144.144.5:3010/runner.js | node`，看到 `connected` 后在房间发送一条
  含较长上下文的回复。旧进程驻留内存，不会因平台端提交或服务重启自动更新。
