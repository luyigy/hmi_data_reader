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
