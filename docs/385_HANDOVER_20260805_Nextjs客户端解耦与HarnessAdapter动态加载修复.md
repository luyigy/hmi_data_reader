---
doc_type: HANDOVER
doc_status: completed
next_action: await_acceptance
plan: null
slice: hotfix
plan_progress: complete
---

# HANDOVER · Next.js 客户端组件解耦与 Harness Adapter 动态加载修复

## 1. 背景与根因

在 Web 客户端打包与访问 `/tasks` 页面时，Next.js dev server 触发编译错误 `Module not found: Can't resolve 'child_process'`，导致打包中途失败。

### 根因分析
1. 前端 Client Component [`TaskForm.tsx`](file:///data1/code/agent-platform-v2/src/components/tasks/TaskForm.tsx#L5-L7) 引用了 [`src/lib/acpx/permissions.ts`](file:///data1/code/agent-platform-v2/src/lib/acpx/permissions.ts)。
2. [`src/lib/acpx/permissions.ts`](file:///data1/code/agent-platform-v2/src/lib/acpx/permissions.ts) 顶层静态 `import { getHarnessAdapter } from '@/lib/harness'`。
3. `src/lib/harness/index.ts` 顶层静态拉取了所有 Harness Adapters (`claude.ts`, `codex.ts`, `deepseek.ts`, `gemini-cli.ts`, `kimi-code.ts`, `pi-agent.ts`, `antigravity.ts`)。
4. 各个 harness adapter 顶层静态引用了后端 Agent 真实实现，拉取了 Node.js 原生模块 (`child_process`, `fs` 等)，导致 Webpack 在编译浏览器端 Chunk 时试图解析 Node 原生依赖而报错。

## 2. 修复措施

### 1) Harness Adapters 改造为动态加载 (`await import(...)`)
补全所有 Harness Adapter 的延迟加载逻辑，在实际调用执行、恢复会话或检查可用性时才按需 `await import(...)` 真实 Agent 模块：
- [`src/lib/harness/adapters/antigravity.ts`](file:///data1/code/agent-platform-v2/src/lib/harness/adapters/antigravity.ts)
- [`src/lib/harness/adapters/claude.ts`](file:///data1/code/agent-platform-v2/src/lib/harness/adapters/claude.ts)
- [`src/lib/harness/adapters/codex.ts`](file:///data1/code/agent-platform-v2/src/lib/harness/adapters/codex.ts)
- [`src/lib/harness/adapters/deepseek.ts`](file:///data1/code/agent-platform-v2/src/lib/harness/adapters/deepseek.ts)
- [`src/lib/harness/adapters/gemini-cli.ts`](file:///data1/code/agent-platform-v2/src/lib/harness/adapters/gemini-cli.ts)
- [`src/lib/harness/adapters/kimi-code.ts`](file:///data1/code/agent-platform-v2/src/lib/harness/adapters/kimi-code.ts)
- [`src/lib/harness/adapters/pi-agent.ts`](file:///data1/code/agent-platform-v2/src/lib/harness/adapters/pi-agent.ts)

### 2) 客户端权限模块环境隔离
- 在 [`src/lib/acpx/permissions.ts`](file:///data1/code/agent-platform-v2/src/lib/acpx/permissions.ts#L116-L128) 中移除顶层 `getHarnessAdapter` 静态导入。
- 仅在服务端环境 (`typeof window === 'undefined'`) 下延迟 `require('@/lib/harness')`，彻底斩断 Client Component 构建时对 Node 依赖树的解析路径。

## 3. 验证情况

1. **Next.js 开发服务编译与请求验证**：
   - 重启 `agent-platform-dev.service` 服务后，Next.js dev server 成功编译 `/tasks` 页面（594 模块），无打包或模块解析报错。
   - 执行 `curl http://127.0.0.1:3010/tasks` 响应 HTTP 200 OK。
2. **长文件守卫检查**：
   - 执行 `npm run check:long-files` 验证，无达到 1000 行阻断阈值的文件。

## 4. 修改文件列表

- [`src/lib/acpx/permissions.ts`](file:///data1/code/agent-platform-v2/src/lib/acpx/permissions.ts)
- [`src/lib/harness/adapters/antigravity.ts`](file:///data1/code/agent-platform-v2/src/lib/harness/adapters/antigravity.ts)
- [`src/lib/harness/adapters/claude.ts`](file:///data1/code/agent-platform-v2/src/lib/harness/adapters/claude.ts)
- [`src/lib/harness/adapters/codex.ts`](file:///data1/code/agent-platform-v2/src/lib/harness/adapters/codex.ts)
- [`src/lib/harness/adapters/deepseek.ts`](file:///data1/code/agent-platform-v2/src/lib/harness/adapters/deepseek.ts)
- [`src/lib/harness/adapters/gemini-cli.ts`](file:///data1/code/agent-platform-v2/src/lib/harness/adapters/gemini-cli.ts)
- [`src/lib/harness/adapters/kimi-code.ts`](file:///data1/code/agent-platform-v2/src/lib/harness/adapters/kimi-code.ts)
- [`src/lib/harness/adapters/pi-agent.ts`](file:///data1/code/agent-platform-v2/src/lib/harness/adapters/pi-agent.ts)
- [`docs/385_HANDOVER_20260805_Nextjs客户端解耦与HarnessAdapter动态加载修复.md`](file:///data1/code/agent-platform-v2/docs/385_HANDOVER_20260805_Nextjs客户端解耦与HarnessAdapter动态加载修复.md)
