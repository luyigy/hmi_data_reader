---
doc_type: HANDOVER
doc_status: completed
next_action: none
plan: null
slice: none
plan_progress: complete
---

# 506. Codex 本次回复失败（spawn codex ENOENT）排障与环境隔离教训

## 日期

2026-10-16

## 故障背景与现象

在飞书任务直播间中，用户向 `codex` 发起咨询时，平台返回系统错误：

```text
系统提示：codex 本次回复失败：spawn codex ENOENT
```

在此错误发生前约 6 分钟，前一轮会话中 `codex` 刚刚完成了业务工作流的代码提交（commit `306dc12`），并向用户说明：
> “我现在安排空闲重载。之后你可以在原来的 549 父任务话题打开 `/ap menu`...”

随后 `agent-platform-feishu.service` 在 23:35:01 重新拉起。当用户在 23:36-23:37 发送下一条消息时，飞书运行时在尝试 spawn `codex` CLI 进程时立即失败，报错 `spawn codex ENOENT`。

---

## 根因深度剖析（RCA）

### 1. 多版本 Node 与 CLI 安装目录的不一致
主机通过 `nvm` 管理多个 Node.js 版本：
- `v22.21.1`
- `v22.22.1`：此前平台与 Agent 工具链安装基准环境，安装了 `@openai/codex`（位于 `/home/hello/.nvm/versions/node/v22.22.1/bin/codex`）、`gitnexus` 等。
- `v24.22.0`：于本日下午 16:11 安装，全局仅包含 `npm@12.2.0` 与 `corepack`，未安装 `codex` 或 `gitnexus`。

### 2. 交互操作导致默认别名漂移（Silent Drift）
本日 16:11，在终端中执行 node / npm 升级操作时，`nvm` 自动将默认别名切换为了 24：
```bash
cat ~/.nvm/alias/default # -> 24
```
**为什么当时没有立即报错？**
因为当时常驻运行的后台服务（`agent-platform-feishu.service` 等）是在更早时间启动的，其进程环境变量（`/proc/<pid>/environ`）中继承的依然是当时的 PATH（包含 Node v22 的 bin 路径），因此白天的任务和 23:30 前的 codex 任务均能正常找到 `codex`。

### 3. 服务空闲重载激活了漂移后的环境变量
在 23:30 codex 安排了空闲服务重启。23:35:01，systemd 重启了 `agent-platform-feishu.service`。
根据 `scripts/run-feishu-runtime.sh`：
```bash
exec /usr/bin/bash -ic 'cd /data1/code/agent-platform-v2 && exec npm run feishu:runtime'
```
该命令以交互式（`-i`）启动 bash，强制重新执行了 `~/.bashrc` 中的：
```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
```
由于 `default` 别名已漂移为 24，`nvm` 将 `/home/hello/.nvm/versions/node/v24.22.0/bin` 注入到了 PATH 最前列，而剔除了旧的 Node 22 bin 目录。

### 4. 子进程直接依赖当前 PATH 中的 `codex`
在 `src/lib/real-agents/codex-agent.ts` 中：
```typescript
const wrapped = wrapWithBubblewrap({
  command: 'codex', // 直接调用 'codex' 命令名，无绝对路径兜底
  ...
});
const child = spawn(wrapped.command, wrapped.args, ...);
```
当系统 PATH 中不存在 `codex` 可执行文件时，Node.js 的 `child_process.spawn` 直接触发底层系统调用失败，抛出 `ENOENT`（No such file or directory）。

---

## 关键教训与防范机制（Learnings）

### 教训 1：严禁依赖可变版本管理器（nvm）的“默认版本”作为生产服务的 PATH
- `nvm` 是面向交互式开发者的版本切换工具。任何人在终端执行 `nvm use`、`nvm install` 或 `npm upgrade`，都极易随手修改 `~/.nvm/alias/default`。
- 生产环境的 systemd 服务如果依赖 `~/.bashrc` 中的动态 nvm 设置，就会在下一次重启时“踩雷”，导致环境不确定性。

### 教训 2：平台核心 Agent 工具链必须常驻持久、全局唯一的 bin 目录
- 类似于 `claude`（通过 `~/.local/bin/claude`）和 `lark-cli`，平台所有必须调度的 Agent CLI（如 `codex`、`gitnexus` 等）不能只存在于某一个特定 node 版本的 `node_modules/.bin` 中。
- 必须在平台通用 PATH 目录（如 `/home/hello/.local/bin/` 或 `/usr/local/bin/`）建立软链接，无论上层 Node 版本如何切换，二进制始终保持可寻址。

### 教训 3：服务启动前与任务派发前的 Preflight 健康检查
- 服务在拉起时（或每个 Agent 派发前），应调用对应 Agent 的 `isAvailable()` 方法进行自检。
- 如果检测到核心依赖缺失（如 `which codex` 失败），应在系统健康日志或管理看板中立即发出告警，而不是等到用户交互时才首现崩溃。

---

## 已执行的修复与验证

1. **固化 Agent 工具链至 `~/.local/bin`**：
   - 建立 `codex` 软链接至官方静态二进制：
     ```bash
     ln -s /home/hello/.codex/packages/app-server-daemon/releases/0.163.0-x86_64-unknown-linux-musl/bin/codex /home/hello/.local/bin/codex
     ```
   - 建立 `gitnexus` 软链接至已安装版本：
     ```bash
     ln -s /home/hello/.nvm/versions/node/v22.22.1/bin/gitnexus /home/hello/.local/bin/gitnexus
     ```
   - 经确认，`~/.local/bin` 在当前运行中服务的 PATH 中已长期包含，因此软链即刻对运行中的 Feishu Runtime 生效。

2. **恢复 nvm 默认版本基线**：
   - 执行 `nvm alias default 22.22.1`，使新的子 shell 默认与主仓工具链一致。

3. **双重可用性验证**：
   - Shell 层：`codex --version` 正常输出 `codex-cli 0.163.0`，`gitnexus --version` 正常输出 `1.6.7-rc.8`。
   - 运行时接口层：通过平台 `src/lib/real-agents/codex-agent.ts` 测试 `isCodexAvailable` 返回 `true`，`getCodexVersion` 正常获取版本。
