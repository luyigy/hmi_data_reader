# 212_HANDOVER_20260722_Feishu用户管理规划

## 任务类型

feature / docs

## 所属主线

临时插队：补齐 Feishu DM 准入后的管理员用户管理闭环。

## 为什么做

当前 DM 准入审批已经能按 `senderOpenId` 拦截新用户，并由 `FEISHU_ADMIN_OPEN_ID` 对应管理员批准或拒绝，但管理员只能通过 Prisma Studio 查看和修改记录。

现状还有两个产品缺口：

- `FeishuUserAccess` 只保存 `openId` 和 `chatId`，管理员看不到 Feishu 用户姓名。
- `denied / revoked` 用户再次 DM 时会重新变成 `pending` 并再次发送审批卡，无法表达永久封禁。

这不是轻量修补：会同时影响准入状态机、Feishu 用户信息解析、管理员命令、卡片展示和安全测试，应在独立会话完成。

## 当前状态

本轮已实现但尚未提交的相关文件：

- `prisma/schema.prisma`
  - `FeishuUserAccess`
  - `FeishuAdminApproval`
- `prisma/migrations/20260722090000_add_feishu_access_approvals/migration.sql`
- `src/lib/feishu-access-approval.ts`
  - P2P 新用户准入拦截
  - 管理员审批卡
  - Full Access 审批
  - 管理员身份校验和条件更新幂等
- `src/lib/feishu-long-connection.ts`、`src/app/api/feishu/webhook/route.ts`
  - 在 Agent/命令处理之前执行 DM 准入检查
- `src/lib/feishu-grant.ts`、`src/lib/feishu.ts`
  - Full Access 共享权限边界
- `tests/feishu-access-approval.test.ts`
  - Full Access 入口识别与未审批拒绝测试

数据库迁移已由用户执行，服务已重启。当前管理员 `open_id` 通过 `.env.feishu.local` 的 `FEISHU_ADMIN_OPEN_ID` 配置。

## 下一会话实施计划

### 1. 明确状态语义

保持最小状态集合并明确行为：

- `pending`：等待管理员处理；重复 DM 不重复发卡。
- `approved`：允许进入现有 DM 流程。
- `denied`：本次申请拒绝；允许以后重新申请。
- `revoked`：撤销已有访问；允许以后重新申请。
- `blocked`：永久封禁；DM 只回复已禁用，不创建申请、不通知管理员。

不要用同一个状态同时表达“临时撤销”和“永久封禁”。

### 2. 保存并展示 Feishu 用户姓名

- 给 `FeishuUserAccess` 增加 `displayName String?` 和可选的 `nameUpdatedAt DateTime?`。
- 优先从入站事件已有字段取姓名；若事件不提供，再通过现有 Feishu API/token 能力查询用户资料。
- 姓名查询失败不能阻断准入：始终保存 `openId`，展示名回退为 `openid:...末六位`。
- 审批卡同时显示 display name、完整 `open_id` 和来源 `chatId`。
- 不新增第三方依赖。

### 3. 增加管理员命令

在现有 `/ap` 命令体系中增加最小管理入口：

- `/ap users [--status=approved|pending|denied|revoked|blocked]`
- `/ap user approve <open_id>`
- `/ap user revoke <open_id>`
- `/ap user block <open_id>`
- `/ap user unblock <open_id>`

所有命令必须验证 `context.senderOpenId === FEISHU_ADMIN_OPEN_ID`。列表至少显示姓名、完整 `open_id`、状态和更新时间。先用文本回复，不做管理 Dashboard 或复杂分页；记录多到单条 Feishu 消息放不下时再加分页。

### 4. 收紧准入检查

- `approved` 才能继续进入 Agent、`/ap` 命令和卡片动作流程。
- `blocked` 永不创建新审批。
- `denied / revoked` 再次 DM 时可创建新的 pending 申请，但同一 pending 只发一次卡。
- 管理员始终直通。
- 已批准用户仍需校验 P2P Binding 的 `chatId`、`senderOpenId` 和访问状态一致。

### 5. 最小验证

- 新用户审批卡显示姓名和完整 `open_id`。
- 非管理员不能列出、批准、撤销或封禁用户。
- `revoke` 后用户不能继续使用，重新 DM 可再次申请。
- `block` 后用户不能使用，也不会产生新申请或管理员卡片。
- `unblock` 后用户可重新申请，但不会自动获批。
- 重复点击审批卡只生效一次。
- 姓名查询失败时仍能按 `open_id` 完成审批。
- 运行 `npx tsc --noEmit` 和一个聚焦的 `tests/feishu-user-management.test.ts`。

## GitNexus 要求

编辑前必须分别对计划修改的现有符号运行 upstream impact。预计至少涉及：

- `checkFeishuDirectMessageAccess`
- `resolveFeishuAdminApproval`
- `parseFeishuCommand`
- `handleFeishuCommand`

若影响为 HIGH 或 CRITICAL，先向用户报告再修改。完成后运行：

```bash
node .gitnexus/run.cjs analyze
```

并使用 `detect_changes({scope: "compare", base_ref: "master"})` 核对影响范围。

## 验证与已知阻塞

- 当前 TypeScript 检查和聚焦测试已通过。
- 当前 `npm run build` 仍被既有客户端依赖链错误打包 Node `child_process` 阻断，与 Feishu 准入改动无关。
- 全量空库 `prisma migrate deploy` 会被历史迁移 `20260321090000_add_openclaw_token` 的迁移链问题阻断；现有开发库迁移已经成功。
- `src/lib/feishu.ts` 已超过 2000 行；下一会话应保持修改窄小，把用户管理逻辑留在独立模块，不继续堆积状态机实现。

## 下一步建议

新会话直接使用：

```text
Read docs/212_HANDOVER_20260722_Feishu用户管理规划.md and implement it.
```
