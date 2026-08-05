---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: docs/383_PLAN_20260804_Inbox优先级议题实施.md
slice: S05
plan_progress: complete
---

# HANDOVER · S05 架构演进 — 鉴权 + Worktree + 远程节点

> 本 HANDOVER 对应 383 PLAN 的 S05（357 + 351 + 350）。
> S05 是 PLAN 383 的最后一个 Slice，至此 5 个 Slice 全部完成。

## 1. 完成内容

### 357：网页登录认证与 RBAC

**User 模型**
- Prisma `User` 模型：`id / username(unique) / passwordHash / role(admin|user) / displayName / timestamps`
- 密码存储：PBKDF2-SHA512（100k 迭代，16-byte salt）
- 迁移文件：`prisma/migrations/20260805163000_add_user_model/migration.sql`

**会话管理（基于现有 auth.ts HMAC 机制）**
- `auth-users.ts`：认证桥接层——先检查环境变量 admin 凭据，再查数据库用户
- `createSessionForUser / verifySessionToken`：封装现有 `createOperatorSession / verifyOperatorSession`
- `registerDbUser / listUsers / deleteUser`：数据库用户 CRUD
- Cookie 名 `ap_auth_token`，httpOnly，24h 过期

**登录系统**
- `/login` 页面：用户名/密码表单，自动检测已登录重定向
- `/api/auth/login`：POST，验证凭据 → 创建会话 → Set-Cookie
- `/api/auth/logout`：POST，清除 Cookie
- `/api/auth/me`：GET，返回当前用户或 401

**前端集成**
- `AuthProvider`：React Context，提供 `user / loading / login() / logout()`
- `Sidebar`：显示用户信息 + 退出按钮，未登录自动跳转 `/login`
- `RootLayout`：包裹 `AuthProvider`
- 现有 `auth.ts` 路由规则表已添加 `/api/auth/*` 为 public

### 351：Git Worktree 工具库

**`src/lib/git-worktree.ts`**
- `listWorktrees(cwd)`：列出所有 worktree（解析 porcelain 格式）
- `createWorktree(cwd, taskId, baseBranch?)`：在 `.worktrees/<safeId>` 创建隔离 worktree
- `removeWorktree(cwd, worktreePath)`：强制移除 worktree + 清理目录
- `pruneWorktrees(cwd)`：清理过期 worktree 引用
- `getGitRoot(cwd) / isWorktree(cwd)`：辅助函数

**使用模式**
```
const worktreeDir = await createWorktree(cwd, taskId, 'main');
// ... 在 worktreeDir 中执行 Agent 任务 ...
await removeWorktree(cwd, worktreeDir);
```

### 350：远程 Agent WebSocket 基础

**`RemoteNode` 模型**
- Prisma 模型：`id / name(unique) / host / secretHash / status(online|offline) / lastSeen / metadata`
- 迁移文件：`prisma/migrations/20260805163500_add_remote_node/migration.sql`

**`remote-node-registry.ts`** — 节点注册管理
- `registerNode(name, host, secret, metadata?)`：注册或更新心跳
- `markNodeOffline(name)`：标记离线
- `listRemoteNodes()`：列出所有节点
- `verifyNodeSecret(name, secret)`：SHA256 比对验证
- `cleanupStaleNodes(maxOfflineHours)`：清理过期离线节点

**`remote-node-ws.ts`** — WebSocket 连接处理
- `handleNodeConnection(ws, req)`：查询参数 `?node=<name>&secret=<secret>` 鉴权
- 连接后注册节点、维持心跳、监听消息
- 断开时自动标记离线
- `sendToNode / broadcastToNodes`：消息发送
- `getConnectedNodeCount / isNodeConnected`：连接状态查询

**`/api/remote-nodes`** — 节点列表 API

## 2. 验证

- `tsc --noEmit` ✅ 零错误
- `check:long-files` ✅ 通过
- `git diff --check` ✅ 干净
- Prisma + DB ✅ 同步（db push）
- `@types/ws` 已安装

## 3. 偏差与未执行项

- **351 仅交付工具库**：Git Worktree 创建/管理函数已就绪，但尚未集成到 `runner-participant.ts` 的任务执行流程中（需要在执行前创建 worktree、执行后清理）
- **350 仅交付基础层**：WebSocket 处理器和节点注册已就绪，但 Live Room / 任务调度尚未接入远程节点路由
- **351 并行调度引擎**：任务拆分与并行 Spawn 机制未实现
- **351 多端并发可视化**：Web/飞书界面的多工作流并发状态面板未实现
- **350 agent-daemon 客户端**：远端机器的守护进程脚本未实现（平台侧已准备好 WebSocket 端点）

## 4. 遗留事项

| 事项 | 优先级 | 说明 |
|------|--------|------|
| 集成 Worktree 到 runner | P1 | `executeViaLocalHarness` 前调用 `createWorktree`，结束后 `removeWorktree` |
| agent-daemon 客户端脚本 | P1 | 远端机器上的轻量级 Node.js 脚本，连接平台 WebSocket |
| Live Room 远程节点路由 | P1 | 将远程节点 Agent 接入 Live Room 编排 |
| 并行任务调度引擎 | P2 | 主控 Agent 拆分任务 + 并发 Spawn |
| 用户管理 UI | P2 | 管理员页面：创建/删除用户、修改角色 |
| 前端全局鉴权集成 | P2 | 所有 API fetch 携带 cookie（当前仅 Sidebar 跳转保护） |

## 5. PLAN 383 完成总览

| Slice | 议题 | 提交 |
|-------|------|------|
| S01 | 380 P0 错误分类 | `59e5546` |
| S02 | 失败可观测性与恢复 | `dfd3147` |
| S03 | Agent 职责分工 | `efeb160` |
| S04 | 执行信息折叠 | `d8b6ddc` |
| S05-357 | 网页登录认证 | `c4d8852` |
| S05-351/350 | Worktree + 远程节点 | (当前提交) |

## 6. 修改文件

- `prisma/schema.prisma`：+`User` 模型 + `RemoteNode` 模型
- `prisma/migrations/20260805163000_add_user_model/`：User 迁移
- `prisma/migrations/20260805163500_add_remote_node/`：RemoteNode 迁移
- `src/lib/auth.ts`：+`AUTH_COOKIE` 常量 + auth API 路由规则
- `src/lib/auth-users.ts`：**新文件**，认证桥接 + 用户管理
- `src/lib/git-worktree.ts`：**新文件**，Git Worktree 工具库
- `src/lib/remote-node-registry.ts`：**新文件**，远程节点注册
- `src/lib/remote-node-ws.ts`：**新文件**，WebSocket 连接处理
- `src/app/api/auth/login/route.ts`：**新文件**
- `src/app/api/auth/logout/route.ts`：**新文件**
- `src/app/api/auth/me/route.ts`：**新文件**
- `src/app/api/remote-nodes/route.ts`：**新文件**
- `src/app/login/page.tsx`：**新文件**
- `src/app/layout.tsx`：包裹 `AuthProvider`
- `src/components/common/AuthProvider.tsx`：**新文件**
- `src/components/common/Sidebar.tsx`：用户信息 + 退出按钮
- `package.json`：+`jose` + `@types/ws`
