# 56 npm run dev 每次重启越来越难的根本原因与解决方案

## 日期
2026-04-04

---

## 问题现象

每次重启 `npm run dev` 时，越来越容易遇到端口 3010 被占用的错误：

```
Error: listen EADDRINUSE: address already in use 0.0.0.0:3010
```

用常规命令杀进程往往失效：

```bash
pkill -f "next dev"          # 失效
kill $(lsof -ti:3010)        # 失效，返回 exit code 1
pkill -f "npm run dev"       # 失效
```

---

## 根本原因

### 进程名会在启动过程中改变

`npm run dev` 启动后，Node.js 的进程名会经历以下变化：

| 阶段 | 进程名 |
|------|--------|
| npm 启动时 | `npm run dev` |
| next 编译时 | `next dev` |
| 服务就绪后 | `next-server (v15.x.x)` |

**关键问题**：常规 `pkill -f "next dev"` 和 `lsof -ti:3010` 针对的是启动阶段的进程名，但服务完全就绪后进程名已变为 `next-server (v15.x.x)`，导致匹配失败。

### `lsof -ti:3010` 为什么会失败

- `lsof` 在某些系统权限配置下无法感知特定进程持有的端口
- 进程名不匹配时 `lsof` 返回空结果，`kill $()` 执行失败（exit code 1）
- 但端口实际上仍被占用，下一次启动就会 EADDRINUSE

### 孤儿进程积累

每次 nohup 启动时若旧进程未被正确杀死，就会留下一个继续持有 3010 端口的后台孤儿进程，导致越重启越乱。

---

## 正确的重启方式

### 第一步：用 `ss` 找到真实 PID（不依赖进程名）

```bash
ss -tlnp | grep 3010
```

输出示例：
```
LISTEN  0  511  0.0.0.0:3010  0.0.0.0:*  users:(("next-server (v1",pid=99588,fd=28))
```

### 第二步：提取 PID 并杀掉

```bash
kill $(ss -tlnp | grep 3010 | grep -oP 'pid=\K[0-9]+')
```

### 第三步：同时清理 feishu 运行时

```bash
pkill -f feishu-standalone-monitor 2>/dev/null
```

### 第四步：等待端口释放后再启动

```bash
sleep 2
nohup npm run dev > logs/dev.log 2>&1 &
nohup npm run feishu:runtime > logs/feishu.log 2>&1 &
```

---

## 完整重启脚本（推荐每次使用）

```bash
cd /data1/code/agent-platform-v2

# 用 ss 精确找到持有 3010 端口的进程并杀掉（不依赖进程名）
PORT_PID=$(ss -tlnp | grep 3010 | grep -oP 'pid=\K[0-9]+')
if [ -n "$PORT_PID" ]; then
  echo "Killing port 3010 holder: PID $PORT_PID"
  kill "$PORT_PID"
fi

# 清理 feishu 运行时
pkill -f feishu-standalone-monitor 2>/dev/null

sleep 2

# 启动两个服务
mkdir -p logs
nohup npm run dev > logs/dev.log 2>&1 &
echo "Next.js PID: $!"
nohup npm run feishu:runtime > logs/feishu.log 2>&1 &
echo "Feishu PID: $!"

# 等待并确认启动成功
sleep 8
echo "=== dev.log ==="
tail -3 logs/dev.log
echo "=== feishu.log ==="
tail -3 logs/feishu.log
```

---

## 核心原则

> **永远用 `ss -tlnp | grep <端口>` 来查找和杀死端口占用者，而不是依赖进程名。**

进程名是不稳定的，端口号是稳定的。

---

## 相关文档

- [52_SERVICE_BACKGROUND_RUN_HANDOVER.md](52_SERVICE_BACKGROUND_RUN_HANDOVER.md) — 服务后台运行基础说明
