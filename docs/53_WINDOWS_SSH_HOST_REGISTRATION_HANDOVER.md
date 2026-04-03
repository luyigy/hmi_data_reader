# 53 Windows SSH 主机注册交接文档

## 日期
2026-04-03

## 背景

本次尝试将 Windows 主机（192.168.31.252）注册为远端 SSH Harness 执行节点。

---

## 最终状态

- 主机状态：**online**（SSH 连接成功）
- 标签：hk-vision
- 地址：`Administrator@192.168.31.252:1822`
- 网络类型：lan
- Working directory：`E:\projects`（见下方注意事项）
- 支持 harness：claude

---

## 注册过程记录

### 1. 生成 SSH 密钥对（在平台服务器上）

```bash
ssh-keygen -t ed25519 -f ~/.ssh/agent-platform -N ""
# 生成：
# ~/.ssh/agent-platform      ← 私钥（粘贴到 Web UI 注册表单）
# ~/.ssh/agent-platform.pub  ← 公钥（放到 Windows 服务器）
```

### 2. 在 Windows 服务器上配置公钥

Windows 的 `Administrator` 账户使用的 authorized_keys 路径与普通用户不同：

```
# 普通用户：C:\Users\<用户名>\.ssh\authorized_keys
# Administrator 账户：C:\ProgramData\ssh\administrators_authorized_keys  ← 必须用这个
```

PowerShell（管理员）操作：
```powershell
New-Item -Path "C:\ProgramData\ssh" -ItemType Directory -Force
Add-Content "C:\ProgramData\ssh\administrators_authorized_keys" "ssh-ed25519 AAAA..."

# 修复权限（必须，否则 OpenSSH 会拒绝此文件）
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "SYSTEM:(F)" /grant "Administrators:(F)"

# 重启 sshd 使配置生效
Restart-Service sshd
```

### 3. 添加防火墙规则

Windows 默认没有开放 SSH 端口，需手动添加：
```powershell
New-NetFirewallRule -Name "OpenSSH" -DisplayName "OpenSSH Server" -Protocol TCP -LocalPort 1822 -Action Allow -Direction Inbound
```

### 4. Web UI 注册

在 `/remote-ssh-tools` 页面填写：
- Label：hk-vision
- Host：192.168.31.252
- Port：**1822**（非默认 22，务必正确填写）
- SSH User：Administrator
- Private Key：粘贴 `cat ~/.ssh/agent-platform` 的完整内容
- Working Directory：`E:\projects`（或留空，见下方注意）
- Harnesses：claude
- Network：lan

---

## 已知问题与注意事项

### Working Directory 路径问题

执行器使用 `bash -lc 'cd <workingDirectory> && ...'` 运行命令。
Windows 路径 `E:\projects` 在 WSL bash 环境下需写为 `/mnt/e/projects`。

**建议**：将 working directory 改为 `/mnt/e/projects` 或留空（使用默认 home 目录）。

### Probe 输出有乱码

SSH 连接成功后 probe 输出包含 WSL 启动消息（乱码为中文 WSL 提示），属于正常现象，不影响执行：
```
wsl: ...WSL...NAT...
```

### claude 可用性未确认

Probe 阶段未明确显示 `claude=ok`，建议：
1. 通过 `/ap add --agents=remote_ssh:<hostId>:claude` 加入房间后实际测试
2. 或通过 `/ap run --host=hk-vision --harness=claude echo hello` 验证

---

## 飞书注册指令（`/ap register`）

除 Web UI 外，也可通过飞书指令注册：

```
/ap register --label=hk-vision --host=192.168.31.252 --user=Administrator --keyfile=/home/hello/.ssh/agent-platform --harnesses=claude --port=1822 --network=lan --workdir=/mnt/e/projects
```

注意：`--keyfile` 是平台服务器上的私钥文件路径。

---

## SSH 密钥逻辑说明

```
平台服务器（运行 agent-platform）        目标服务器（Windows/Linux）
────────────────────────────────         ──────────────────────────
私钥 ~/.ssh/agent-platform               authorized_keys（存公钥）
  ↓ 粘贴到 Web UI 或 /ap register          ↑ 一次性手动配置
  ↓
平台发起 SSH 连接 ──────────────────────→ 验证公钥，允许连接
```

**私钥永远在平台服务器上，粘贴到 Web UI 是为了让平台代持并加密存储。**
