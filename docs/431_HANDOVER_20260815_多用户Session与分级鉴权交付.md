---
doc_type: HANDOVER
doc_status: completed
next_action: next_slice
plan: docs/430_PLAN_20260815_多用户认证与WebUI配对接入.md
slice: S01
plan_progress: in_progress
---

# HANDOVER · 多用户Session与分级鉴权交付

## 完成内容

- v1 bootstrap 管理员 Session 保持兼容；`createSessionForUser()` 改为签发包含真实 `userId`、`role`、`subject` 的 v2 Claims。
- 新增异步 `requireCurrentUser(request)` / `requireAdmin(request)`；数据库用户每次鉴权均按 ID 重读，删除或降权立即生效。
- 路由策略拆分为 `public`、`authenticated`、`admin`，未声明路由默认拒绝；中央 `middleware.ts` 已实际执行页面/API 粗粒度拦截。
- 普通用户只被授予 Tasks、Live Rooms、Remote Nodes 路由级访问；Workspace、Gateway、Platform Local 等管理面仍为 admin。
- 修复数据库普通用户用户名为 `admin` 时可能与 v1 bootstrap 身份混淆的边界，并让畸形 Cookie fail closed。

## 验证

- `npm run test:auth-users`
- `TS_NODE_BASEURL=. TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' node -r ts-node/register/transpile-only -r tsconfig-paths/register tests/auth.test.ts`
- `npx tsc --noEmit`
- `npm run check:long-files`
- `git diff --check`
- `npm run build`

以上全部通过；长文件守卫无阻断文件。

## S02 注意事项

- S01 仅完成身份与路由级鉴权，资源查询尚未按 owner 过滤；完成 S02 前不可把普通用户入口视为可上线状态。
- middleware 通过同源 `/api/auth/me` 复用数据库实时复核，Route Handler 中仍必须使用 `requireCurrentUser` / `requireAdmin` 做资源所有权和敏感操作校验。
- 工作区另有 5 个与本 PLAN 无关的既有修改，本次未暂存、未提交。

<!-- WORKFLOW_PROMPT_START -->
读取 `docs/431_HANDOVER_20260815_多用户Session与分级鉴权交付.md`、`docs/430_PLAN_20260815_多用户认证与WebUI配对接入.md` 和 `docs/workflow/workflow-contract.yaml`，只执行 S02。
完成验证、创建下一 HANDOVER、提交后停止。
<!-- WORKFLOW_PROMPT_END -->
