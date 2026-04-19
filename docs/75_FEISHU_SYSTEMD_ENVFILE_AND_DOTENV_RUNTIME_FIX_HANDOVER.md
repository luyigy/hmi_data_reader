# 75. FEISHU_SYSTEMD_ENVFILE_AND_DOTENV_RUNTIME_FIX_HANDOVER

## 日期

2026-04-19

## 本轮目标

修复 Feishu runtime 在本机无法启动的问题，确认是 env / systemd 启动链路故障，而不是 Feishu app 凭据本身失效。

---

## 结论

本次故障分成两层：

### 1. 安装到用户目录的 systemd unit 是旧版本

实际生效的文件：

- `/home/hello/.config/systemd/user/agent-platform-feishu.service`

它仍然包含：

```ini
EnvironmentFile=/home/hello/.env
```

而该文件已经不存在，所以 systemd 在执行 `ExecStart` 之前就直接失败，日志为：

```text
Failed to load environment files: No such file or directory
Failed to run 'start' task: No such file or directory
```

这不是 Feishu 凭据错误，而是 unit 文件已经落后于仓库版本。

### 2. 即使移除旧 `EnvironmentFile`，启动脚本仍会因为 dotenv 文件格式退出

`scripts/run-feishu-runtime.sh` 原本会：

```bash
source .env.feishu.local
```

但 `.env.feishu.local` 是 dotenv 风格，不保证是合法 shell。像：

```dotenv
FEISHU_BOT_NAME=Agent Platform AI
```

被 Bash `source` 时会触发：

```text
.env.feishu.local: line 9: AI: command not found
```

导致 Feishu service 退出码为 `127`。

---

## 本轮修改

### A. 修复 runtime env 加载方式

文件：

- `scripts/run-feishu-runtime.sh`

改动：

- 新增 `load_dotenv_file()`
- 不再 `source` `.env.feishu.local`
- 改为按行读取 `KEY=VALUE`
- 跳过空行和注释
- 兼容可选的 `export `
- 兼容被单引号或双引号包裹的值

效果：

- `.env.feishu.local` 可以继续保持 dotenv 写法
- 带空格的值不会再把 service 启动打挂

### B. 重新安装 systemd user services

执行：

```bash
bash scripts/install-systemd-user-services.sh
```

结果：

- `/home/hello/.config/systemd/user/agent-platform-feishu.service`
- `/home/hello/.config/systemd/user/agent-platform-dev.service`

都被覆盖为仓库当前版本。

---

## 验证结果

依据：

- `docs/SYSTEMD_USER_COMMANDS.md`

仓库规定的服务名仍然是：

- `agent-platform-dev.service`
- `agent-platform-feishu.service`

修复后已确认：

```bash
systemctl --user is-active agent-platform-feishu.service
```

返回：

```text
active
```

同时 recent journal 中出现：

```text
[FeishuRuntime] started
[ws] ws client ready
```

说明 Feishu standalone runtime 已经重新进入正常运行态。

---

## 排查过程中确认但不是本次根因的点

### 1. Web 服务本身是正常的

`agent-platform-dev.service` 在排查时一直是 `active (running)`，不是这次故障点。

### 2. Feishu 凭据已恢复

直接手工跑 `npm run feishu:runtime` 时，runtime 能启动到：

- `event-dispatch is ready`
- `card-action-handle is ready`
- `started`

因此“补回 env 后仍不能启动”的核心问题不在凭据缺失，而在 systemd + startup script。

### 3. 旧日志里的 Prisma `workingDirectory` 错误不是当前 startup blocker

该报错来自更早的 runtime / Prisma client 状态，不是这次 service 无法启动的直接原因。

---

## 相关文件

- `scripts/run-feishu-runtime.sh`
- `docs/SYSTEMD_USER_COMMANDS.md`
- `deploy/systemd-user/agent-platform-feishu.service`
- `scripts/install-systemd-user-services.sh`
