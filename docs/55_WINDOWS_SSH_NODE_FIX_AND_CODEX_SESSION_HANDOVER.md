# 55 Windows SSH node 缺失修复与 local codex 续接修复交接文档

## 日期
2026-04-04

---

## 一、Windows SSH 主机 claude 执行失败：node not found

### 问题描述

`@hk-vision Claude hello` 触发后，飞书收到系统提示：`hk-vision Claude 本次回复失败：w`

错误信息只有一个字母 "w"，明显异常。

### 根本原因

**两个叠加问题：**

1. **`node` 未安装在 WSL Linux 层**
   Windows 机器上的 `claude` 是通过 Windows npm 全局安装的（路径 `/mnt/c/Users/Administrator/AppData/Roaming/npm/claude`），是一个调用 `node` 的 shell 脚本。但 Windows OpenSSH 通过 WSL 执行命令时，**Windows Interop 被禁用**（exec format error），导致 `node.exe` 无法从 WSL 内执行。

2. **错误信息被截断为 "w"**
   WSL 启动时输出 UTF-16LE 编码的中文提示（`wsl: 检测到 localhost...`），Node.js `data.toString()` 将其解码为含大量 `\0` 字节的字符串（`w\0s\0l\0:...`）。该字符串存入 SQLite 后，被 C 字符串截断规则截为第一个 `\0` 前的 `w`，导致飞书只显示 `w`。

### 已修复：错误信息展示

**`src/lib/live-room-delivery.ts`**（commit `ede113a`）：

```typescript
// 清除 null 字节
let normalized = message.replace(/\0/g, '');

// 新增 WSL 启动消息过滤
const SSH_WARNING_PATTERNS = [
  /^Warning: Permanently added .*known hosts\.\s*$/gim,
  /^wsl:.*$/gim,   // ← 新增
];
```

现在错误信息会正确显示为 `node: not found`（或类似）而非 `w`。

### 需用户操作：在 WSL 中安装 Node.js

**在 Windows 机器的 WSL 终端（用户 `ww`）中执行：**

```bash
# 1. 将 nvm 加入 login shell 配置（bash -lc 会加载 /etc/profile.d/）
sudo tee /etc/profile.d/nvm.sh << 'EOF'
export NVM_DIR="/home/ww/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
EOF

# 2. 重载（或新开终端）
source /etc/profile.d/nvm.sh

# 3. 确认 node 可用
node --version   # 应输出 v24.x.x

# 4. 在 WSL 中单独安装 claude CLI（与 Windows 侧分开）
npm install -g @anthropic-ai/claude-code

# 5. 登录
claude login
```

**为什么不能用 Windows 侧的 node：**
Windows OpenSSH 发起 WSL bash 会话时，Windows Interop（执行 .exe 的机制）被禁用，WSL 内无法调用 `node.exe`。必须在 WSL Linux 层单独安装。

**为什么要放在 `/etc/profile.d/`：**
SSH 执行器使用 `bash -lc`（login shell），login shell 会 source `/etc/profile` → `/etc/profile.d/*.sh`。WSL 的 `HOME` 变量在 SSH 会话中被覆盖为 Windows Administrator 的路径，导致 `~/.bashrc` 找不到。`/etc/profile.d/nvm.sh` 是与 `HOME` 无关的固定路径，因此更可靠。

### 诊断记录

| 现象 | 原因 |
|------|------|
| `bash -lc 'echo HOME=$HOME'` 输出 `HOME=C:\Users\Administrator` | Windows SSH 将 HOME 覆盖为 Windows 路径 |
| `bash -lc 'which node'` 无输出 | WSL 内 PATH 未包含 node，nvm 未加载 |
| `bash -lc '_H=/home/ww; HOME=$_H; . $_H/.bashrc; which node'` 输出 `v24.11.0` | nvm 已安装，只是 HOME 错误导致未被加载 |
| `cmd.exe /c ...` 报 `Exec format error` | Windows Interop 在 SSH 会话中被禁用 |

---

## 二、local codex 续接修复

### 问题描述

`platform_local + codex` 每次对话都启动全新 codex 会话，无法记住上一轮实际执行的工具调用和文件修改。

### 根本原因

`live-room-delivery.ts` 中有一个硬编码的强制 ephemeral 条件：

```typescript
// 旧代码（有问题）
const useEphemeralCodexSession =
  participant.executionBackend === 'platform_local'
  && participant.harnessType === 'codex';   // 始终为 true → 始终 ephemeral
const shouldUseContinuation =
  !useFreshSession
  && !useEphemeralCodexSession   // ← 永远为 false，永远不续接
  && Boolean(latestSession?.continuationSessionId);
```

### 修复方案

**`src/lib/live-room-delivery.ts`**（commit `35cd436`）：

```typescript
// 新代码
const shouldUseContinuation =
  !useFreshSession
  && !forceEphemeral          // ← 只在显式强制 ephemeral 时跳过续接
  && Boolean(latestSession?.continuationSessionId);
```

同步修复 `ephemeralSession` 字段：
```typescript
// 旧
ephemeralSession: useEphemeralCodexSession || forceEphemeral,
// 新
ephemeralSession: forceEphemeral,
```

### 修复后的执行流程

```
第 1 轮消息
  → 无 prior session → 启动全新 codex thread
  → 执行完成，threadId 存入 TaskRunParticipant.controlMetadata

第 2 轮消息
  → findLatestParticipantSession 找到 threadId
  → shouldUseContinuation = true
  → codex exec resume <threadId>（codex 记得上一轮所有工具调用）

codex state DB 报错时（SQLite 锁等）
  → shouldRetryCodexEphemeral 检测到错误 → forceEphemeral: true
  → 回退为 ephemeral 模式（原有兜底路径，未改动）
```

### 各 backend 续接方式对比

| backend + harness | 续接方式 | session 标识 |
|---|---|---|
| platform_local + codex | `codex exec resume <threadId>` | `codex_thread` |
| platform_local + claude | `claude --resume <sessionId>` | `claude_session` |
| remote_ssh + codex | `codex exec resume <threadId>` over SSH | `codex_thread` |
| remote_ssh + claude | `claude --resume <sessionId>` over SSH | `claude_session` |

所有 backend 现在行为一致，均优先尝试续接，失败时回退。

---

## 文件变更清单

| 文件 | commit | 说明 |
|------|--------|------|
| `src/lib/live-room-delivery.ts` | `ede113a` | 清除 null 字节，新增 WSL 消息过滤 |
| `src/lib/live-room-delivery.ts` | `35cd436` | 移除 local codex 强制 ephemeral，改为优先 thread 续接 |
| `src/lib/remote-harness/ssh-executor.ts` | `ede113a` | （已在 8165c3a 回滚复杂 HOME 修复，最终保持 bash -lc 原样） |
