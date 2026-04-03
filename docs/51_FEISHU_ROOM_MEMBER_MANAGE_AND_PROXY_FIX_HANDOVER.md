# 51 飞书房间成员管理与代理修复交接文档

## 日期
2026-04-03

## 本次工作背景

上一篇（50）实现了飞书双向中继和 SSH 直连 Harness。
本次继续调试，解决了以下问题：
1. 飞书指令无法管理 live room 成员（无踢出/添加指令）
2. feishu runtime 进程因代理变量被剥离导致 codex 无法联网，一直挂起

---

## 本次实现内容

### 1. Live Room 成员管理 API

**新增 DELETE 端点**：`DELETE /api/live-rooms/[id]/members/[memberId]`

- 检查成员存在且属于该 room
- 拒绝删除 user 类型成员（防止踢出自己）
- 删除成员后若被踢者是当前 speaker，自动将 speaker 切换为下一个可回复成员
- 发送系统消息到 live room 告知成员已移除

文件：`src/app/api/live-rooms/[id]/members/[memberId]/route.ts`

---

### 2. 新增飞书指令（`src/lib/feishu.ts`）

#### `/ap members`
列出当前飞书会话绑定的 live room 的所有成员，格式：
```
Live Room 成员列表 (88079wd9)
- 你 [amggefqx] | local | (you)
- codex [sr2710we] | platform_local | idle
```

#### `/ap kick <memberName>`
按显示名（大小写不敏感、支持子串匹配）移除成员：
```
/ap kick claude   → ✅ 已将 claude 从房间移除。
```

#### `/ap add --agents=<agentId>`
向已绑定房间添加新成员：
```
/ap add --agents=platform_local:platform-local:codex
```

**辅助函数 `getBoundLiveRoomId(context)`**：
- 通过 scopeKey 查 `FeishuConversationBinding`
- 供 members / kick / add 三个指令共用

**指令白名单和类型定义同步更新**（`ParsedFeishuCommand.command`）。

---

### 3. 修复 codex 代理/网络问题

**问题**：`npm run feishu:runtime` 原来用 `env -u` 剥离了所有代理变量，
导致 feishu runtime 进程里的 codex 无法通过代理访问 OpenAI API，一直挂起（10m+ 无响应）。

**诊断**：在 `codex-agent.ts` spawn 前加了临时日志 `[Codex] Spawn env check: {...}`，
确认 `http_proxy / https_proxy / OPENAI_API_KEY` 全部 `(unset)`。

**修复**：`package.json` 中的 `feishu:runtime` 脚本去掉所有 `-u` 代理参数，
让进程直接继承 shell 的代理环境变量：

```json
// 修复前
"feishu:runtime": "env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY node scripts/feishu-standalone-monitor.js"

// 修复后
"feishu:runtime": "node scripts/feishu-standalone-monitor.js"
```

**临时诊断日志**已在修复确认后从 `codex-agent.ts` 移除。

---

## 已验证工作流程

```
飞书群里：
1. /ap agents                    → 列出所有可用 agent
2. /ap hosts                     → 列出 SSH 主机
3. /ap room --agents=platform_local:platform-local:codex  → 创建/复用绑定房间
4. /ap members                   → 查看房间成员
5. /ap kick claude               → 踢出 claude
6. hello（普通消息）              → 自动中继到 live room，codex 回复后推回飞书
7. /ap chat hello                → 同上（显式命令版）
```

**注意**：普通消息和 `/ap chat` 会各自独立触发一次 codex 执行，
造成重复回复。建议只使用其中一种方式。

---

## 已知遗留问题

1. **重复回复**：同时发送普通消息和 `/ap chat` 会触发两次 codex 执行 → 避免混用即可
2. **codex OPENAI_API_KEY**：通过 `~/.codex/` 订阅认证，无需在 `.env` 配置
3. **claude 403**：`ANTHROPIC_API_KEY` 未在当前环境配置，claude 本地执行无法使用

---

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `package.json` | 修改 | 去掉 feishu:runtime 的代理剥离参数 |
| `src/app/api/live-rooms/[id]/members/[memberId]/route.ts` | 修改 | 新增 DELETE 移除成员端点 |
| `src/lib/feishu.ts` | 修改 | 新增 members / kick / add 指令及辅助函数 |
| `src/lib/real-agents/codex-agent.ts` | 无净变更 | 临时诊断日志已移除，恢复原状 |
