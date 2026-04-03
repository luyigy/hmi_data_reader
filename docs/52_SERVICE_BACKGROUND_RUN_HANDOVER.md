# 52 后台运行服务与日志查看交接文档

## 日期
2026-04-03

## 服务概览

本平台需要同时运行两个独立进程：

| 服务 | 启动命令 | 日志文件 | 作用 |
|------|----------|----------|------|
| Next.js 主服务 | `npm run dev` | `logs/dev.log` | Web UI + API 路由，端口 3010 |
| 飞书长连接运行时 | `npm run feishu:runtime` | `logs/feishu.log` | 飞书 WebSocket 消息收发 |

---

## 后台启动（推荐方式）

```bash
cd /data1/code/agent-platform-v2

# 确保日志目录存在
mkdir -p logs

# 启动两个服务到后台
nohup npm run dev > logs/dev.log 2>&1 &
nohup npm run feishu:runtime > logs/feishu.log 2>&1 &
```

启动后确认两个进程都在运行：
```bash
pgrep -a node | grep -E "next|feishu"
```

正常输出示例：
```
12345 node scripts/feishu-standalone-monitor.js
67890 node /data1/code/agent-platform-v2/node_modules/.bin/next dev -H 0.0.0.0 -p 3010
```

---

## 查看日志

### 实时追踪
```bash
# 飞书运行时（最常用，看消息收发和 agent 执行）
tail -f logs/feishu.log

# Next.js 主服务（看 API 请求和错误）
tail -f logs/dev.log

# 同时看两个
tail -f logs/feishu.log logs/dev.log
```

### 飞书日志关键字说明

| 关键字 | 含义 |
|--------|------|
| `[ws] ws client ready` | 飞书 WebSocket 连接成功 |
| `[FeishuRuntime] command received` | 收到一条 `/ap` 指令 |
| `[FeishuRuntime] command handled` | 指令处理完成 |
| `[FeishuRuntime] reply sent` | 回复已发回飞书 |
| `[Codex] Executing task` | 本地 codex 开始执行 |
| `[Codex] Exec args` | codex 实际调用参数 |
| `[Mention Detection]` | 消息中的 @提及 解析过程 |
| `[Task Room]` | 任务房间上下文构建 |
| `[WARN] OPENCLAW_ENCRYPTION_KEY not set` | 无害警告，可忽略 |

---

## 停止服务

```bash
# 停止 Next.js
kill $(lsof -ti:3010)

# 停止飞书运行时
pkill -f feishu-standalone-monitor

# 或一次性停止所有相关进程
kill $(lsof -ti:3010) 2>/dev/null
pkill -f feishu-standalone-monitor 2>/dev/null
```

---

## 重启服务

```bash
cd /data1/code/agent-platform-v2

# 停止旧进程
kill $(lsof -ti:3010) 2>/dev/null
pkill -f feishu-standalone-monitor 2>/dev/null
sleep 2

# 重新启动
nohup npm run dev > logs/dev.log 2>&1 &
nohup npm run feishu:runtime > logs/feishu.log 2>&1 &

# 等待启动完成
sleep 8
tail -3 logs/dev.log
tail -3 logs/feishu.log
```

---

## 注意事项

1. **启动顺序无强制要求**，两个进程互相独立，但建议先起 Next.js 再起飞书运行时
2. **端口冲突**：若 3010 端口已被占用（上次未正常退出），先 `kill $(lsof -ti:3010)` 再启动
3. **代理变量**：`npm run feishu:runtime` 会继承 shell 的代理环境变量（`http_proxy` 等），codex 联网需要代理的话确保启动前 shell 里已设置
4. **飞书长连接断开后自动重连**：SDK 内置重连机制，无需手动重启；但若报 `error` 状态，建议重启飞书运行时
5. **日志文件会持续增长**，长期运行建议配置 logrotate 或定期清空

---

## 常见问题

**飞书没有回复？**
```bash
tail -20 logs/feishu.log  # 确认 ws client ready
grep "error\|Error" logs/feishu.log | tail -10
```

**端口被占用启动失败？**
```bash
lsof -i:3010  # 查看占用进程
kill $(lsof -ti:3010)
```

**codex 卡住不回复？**
```bash
grep "Codex\|codex" logs/feishu.log | tail -20  # 看执行状态
# 若卡住超时，下次消息会自动触发新的执行
```
