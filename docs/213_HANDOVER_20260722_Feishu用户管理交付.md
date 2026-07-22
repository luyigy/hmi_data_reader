# 213_HANDOVER_20260722_Feishu用户管理交付

## 任务类型

feature / bugfix / test / docs

## 所属主线

临时插队：补齐 Feishu DM 准入后的管理员用户管理闭环。

## 为什么做

原有 DM 准入只能通过 Prisma Studio 管理，审批卡也无法显示用户名；同时 `denied / revoked` 与永久封禁语义混淆。上线后又发现 Codex stdout 流式碎片被逐条转发到 Feishu，造成“结巴”式系统提示，Typing reaction 回推事件也产生未注册 handler 告警。

## 修改内容

### 用户准入状态

- `pending`：等待管理员处理；重复 DM 不重复发送审批卡。
- `approved`：允许进入 Agent、`/ap` 命令和普通卡片动作流程。
- `denied`：本次申请被拒绝；再次 DM 可重新申请。
- `revoked`：已有访问被撤销；再次 DM 可重新申请。
- `blocked`：永久封禁；DM 只回复访问已禁用，不创建申请或通知管理员。
- 配置的 `FEISHU_ADMIN_OPEN_ID` 始终直通。
- 已批准用户仍需匹配同一 P2P `chatId`、`senderOpenId` 和 conversation binding。

### 用户姓名与审批卡

- `FeishuUserAccess` 新增 `displayName` 和 `nameUpdatedAt`。
- 新申请通过 Feishu Contact API 查询姓名；查询失败不阻断审批，回退为 `openid:...末六位`。
- 用户准入审批卡显示姓名、完整 `open_id` 和来源 `chatId`。

### 管理员命令

以下命令仅允许 `senderOpenId === FEISHU_ADMIN_OPEN_ID` 的管理员执行：

```text
/ap users
/ap users --status=approved
/ap users --status=pending
/ap users --status=denied
/ap users --status=revoked
/ap users --status=blocked
```

列表按更新时间倒序显示姓名、完整 `open_id`、状态和更新时间。

```text
/ap user approve <open_id>
```

批准用户并确保建立默认 Safe Local P2P binding。已封禁用户必须先解除封禁。

```text
/ap user revoke <open_id>
```

撤销当前访问；用户下次 DM 会重新进入 `pending` 审批。

```text
/ap user block <open_id>
```

永久封禁并关闭该用户尚未处理的准入申请；后续 DM 不再通知管理员。

```text
/ap user unblock <open_id>
```

解除永久封禁并转为 `revoked`；不会自动批准，用户下次 DM 才会重新申请。

### Feishu “结巴”修复

- Feishu relay 不再转发 metadata 为 `member_reply_progress` 的 stdout/stderr 碎片。
- 保留开始提示、聚合工具进度和最终 assistant 回复。
- 注册 `im.message.reaction.created_v1` 与 `im.message.reaction.deleted_v1` 空处理器，消除机器人添加/删除 Typing reaction 时的 SDK 告警。

### 主要文件

- `prisma/schema.prisma`
- `prisma/migrations/20260722090000_add_feishu_access_approvals/migration.sql`
- `prisma/migrations/20260722150000_add_feishu_user_display_name/migration.sql`
- `src/lib/feishu-access-approval.ts`
- `src/lib/feishu-api.ts`
- `src/lib/feishu-long-connection.ts`
- `src/lib/feishu-live-room-relay.ts`
- `src/app/api/feishu/webhook/route.ts`
- `src/lib/feishu.ts`
- `src/lib/feishu-grant.ts`
- `tests/feishu-access-approval.test.ts`
- `tests/feishu-user-management.test.ts`
- `tests/feishu-live-room-relay.test.ts`

## 验证结果

- 用户已应用数据库迁移并确认 Feishu 实际会话恢复正常，不再出现碎片化“正在处理中”消息。
- `npx tsc --noEmit`：通过。
- `npx --yes tsx tests/feishu-user-management.test.ts`：通过。
- `npx --yes tsx tests/feishu-access-approval.test.ts`：通过。
- `npx --yes tsx tests/feishu-live-room-relay.test.ts`：通过。
- `npx --yes tsx tests/feishu-mode-command.test.ts`：通过。
- `git diff --check`：通过。
- 已运行 `node .gitnexus/run.cjs analyze` 和 GitNexus `detect_changes(compare master)`。

## 对主线的影响

Feishu DM 准入现在具备可读身份、管理员命令、临时撤销、永久封禁和安全重申请的完整闭环；同时移除了影响实际聊天体验的流式碎片转发。未增加 Dashboard 或分页，当前文本列表足够现阶段使用。

## 下一步建议

继续原主线任务。仅当用户记录多到单条 Feishu 消息无法容纳时，再为 `/ap users` 增加分页。
