---
doc_type: FIX
doc_status: completed
next_action: none
---

# FIX · /runner.js 分发产物 shebang 语法错误修复

## 问题描述

S04（`4420d07`）交付的 `/runner.js` 分发路由在脚本前预置
`process.env.AGENT_PLATFORM_SERVER=…;` 引导行，把
`scripts/agent-platform-runner.js` 首行的 `#!/usr/bin/env node` 挤到**第 2 行**。
Node 只允许 shebang 出现在第 1 行，导致 Web UI 配对弹窗展示的一键命令在任何执行
方式下都直接 SyntaxError（S04 验收测试 PASSED 判定为 FAILED 的阻断缺陷 1）：

```
$ curl -fsSL http://<host>/runner.js | node - --pairing-token=<TOKEN>
[stdin]:2
#!/usr/bin/env node
^
SyntaxError: Invalid or unexpected token
```

先落盘再执行（`node downloaded-runner.js`）同样在第 2 行报错。

## 根因分析

`src/app/runner.js/route.ts`：

```ts
return new Response(`process.env.AGENT_PLATFORM_SERVER=…;\n${source}`, …);
```

预置行插入在 shebang 之前，破坏了 Node 的 shebang 容忍规则（仅第 1 行有效）。

## 修复方案

拼接前剥离源码首行 shebang：

```ts
const body = source.replace(/^#![^\n]*\n?/, '');
return new Response(`process.env.AGENT_PLATFORM_SERVER=…;\n${body}`, …);
```

剥离后产物第 1 行为引导赋值、其后为纯脚本，`node -`（stdin）与
`node file.js` 均可执行。

## 改动点

1. **`src/app/runner.js/route.ts`**：如上剥离 shebang。
2. **`tests/pairing.test.ts`**：新增回归断言——直接调用路由 `GET`：
   - 首行匹配 `process.env.AGENT_PLATFORM_SERVER="http://pairing.test";`
   - 产物不以 `#!` 开头，且第 2 行起无任何 `#!` 行；
   - `new vm.Script(body)` 编译通过（语法级回归，等价 `node --check`）。

## 验证情况

- `npm run test:pairing`（含新增断言）通过；`npx tsc --noEmit` 通过。
- 隔离 dev server（:3011）实测验收入口原命令：
  `curl -fsSL http://127.0.0.1:3011/runner.js | node - --pairing-token=<T>`
  → `Paired remote node: hello-c6841304`，
  `~/.agent-platform/runner.json` 以 `0600` 持久化，`server/node/token/workspace` 齐全。

## 关联

- S04 验收报告（缺陷 1）；PLAN `docs/430_PLAN_20260815_多用户认证与WebUI配对接入.md`。
- 同报告缺陷 2（迁移未应用）已在验收阶段以 `npx prisma migrate deploy` 前向应用
  已提交迁移 `20260815153000_add_pairing_tickets` 解决；长驻 dev server 需重启以加载
  新 Prisma Client（见平台运维说明）。
