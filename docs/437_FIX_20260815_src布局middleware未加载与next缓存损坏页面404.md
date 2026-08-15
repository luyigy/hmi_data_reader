---
doc_type: FIX
doc_status: completed
next_action: none
---

# FIX · middleware 未随 src 布局加载与 .next 缓存损坏导致的页面 404

## 问题描述

两个叠加问题造成平台网页首页等页面异常：

1. **页面 404（`/`、`/login`、`/admin/users`、`/remote-ssh-tools` 瞬回 404，无编译动作）**
   ——常驻 systemd dev server（:3010，8月13 启动）与仓库共享 `.next` 目录；期间
   `next build`（生产构建验证）与隔离端口上的第二个 `next dev` 先后写入/清空同一
   `.next`，增量块与 webpack runtime 失配（journal：`Cannot find module './8948.js'`
   in `.next/server/webpack-runtime.js`），路由清单部分失效。
2. **页面级鉴权从未生效（更严重的隐藏缺陷）**——项目为 `src/` 布局（`src/app`），
   但 S01 交付的 `middleware.ts` 放在仓库根目录。Next.js 要求 src 布局时 middleware
   必须位于 `src/middleware.ts`，根目录文件**不会被加载**。表现为：未登录请求
   `/rooms`、`/tasks` 等受保护页面直接 200（仅靠客户端 AuthProvider 跳转兜底），
   `public/authenticated/admin` 路由策略在服务端全部空转；API 侧因 Route Handler
   自行调用 `requireCurrentUser` 未受影响。

## 根因分析

- `.next` 为 dev server 私有增量状态，任何并发的 `next build` / 第二个 `next dev`
  都会破坏它；服务本身不崩溃，仅部分路由 404，极具迷惑性。
- Next.js middleware 解析规则：使用 `src` 目录时只读取 `src/middleware.ts`。

## 修复方案

1. **middleware 归位**：`git mv middleware.ts src/middleware.ts`；
   `tests/auth-users.test.ts` 的导入同步改为 `../src/middleware`。
2. **运维处置（无代码变更）**：`systemctl --user stop agent-platform-dev.service`
   → `rm -rf .next` → `start`。该服务仅承载 Web UI；Feishu runtime 与 scheduled
   jobs 为独立 systemd 单元，重启不影响活跃 agent 会话。重启同时让常驻进程加载
   S04 之后重新生成的 Prisma Client（`PairingTicket` 模型），`/api/pairing-tickets`
   由 500 恢复为 401/201。

## 验证情况（实测 :3010）

- 未登录：`/`、`/rooms` → `307 → /login?next=…`；`/login` → 200；`/api/auth/me` → 401。
- admin 登录：`/` 200、`/admin/users` 200；普通用户：`/` 200、`/admin/users` → **403**。
- 之前 404 的四个页面全部恢复 200（未登录态下受保护页正确 307）。
- 普通用户 `POST /api/pairing-tickets` → 201（S04 链路在常驻平台闭环）。
- `npm run test:auth-users`（含 middleware 断言）、`test:admin-users`、`test:pairing`
  通过；`npx tsc --noEmit` 通过。

## 经验记录

- 在常驻 dev server 存在的仓库里执行 `npm run build` 或再起 `next dev`，应先停服或
  使用独立构建目录（`distDir`），否则会静默破坏线上页面路由。
- 后续如出现"部分页面瞬回 404 且无 Compiling 日志"，优先怀疑 `.next` 损坏而非代码。
