# 跨网关 Agent 注册指南

本文档说明如何在 Agent Platform 中注册远程 OpenClaw 实例的 Agent。

---

## 🏗️ 架构说明

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Platform v2                         │
│                   (主网关 / 管理平台)                         │
│                  localhost:3000                              │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Local Node   │  │ Remote Node  │  │ Cloud Node   │      │
│  │ 本地网关      │  │ 远程网关      │  │ 云端网关      │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                 │                 │               │
│    ┌────┴────┐       ┌────┴────┐       ┌────┴────┐         │
│    │ Agents  │       │ Agents  │       │ Agents  │         │
│    └─────────┘       └─────────┘       └─────────┘         │
└─────────────────────────────────────────────────────────────┘
```

---

## 📋 注册方式

### 方式 1：手动注册（适合测试）

#### Step 1: 创建远程 Node

```bash
curl -X POST http://localhost:3000/api/nodes \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Remote Gateway - Office PC",
    "ip": "192.168.1.100:8080",
    "resources": {
      "cpu": "8 cores",
      "memory": "16GB",
      "disk": "500GB"
    }
  }'
```

**响应示例**:
```json
{
  "id": "cn_xxx",
  "name": "Remote Gateway - Office PC",
  "ip": "192.168.1.100:8080",
  "status": "offline",
  "createdAt": "2026-03-11T00:00:00.000Z"
}
```

#### Step 2: 创建 Agent 关联到 Node

```bash
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Remote Coder Agent",
    "type": "coding",
    "location": "remote",
    "capabilities": ["python", "typescript", "code-review"],
    "nodeId": "cn_xxx"
  }'
```

**响应示例**:
```json
{
  "id": "ag_yyy",
  "name": "Remote Coder Agent",
  "type": "coding",
  "location": "remote",
  "status": "offline",
  "nodeId": "cn_xxx",
  "capabilities": "[\"python\",\"typescript\",\"code-review\"]"
}
```

---

### 方式 2：自动注册（推荐）

在远程 OpenClaw 实例上运行自动注册脚本。

#### Step 1: 配置环境变量

在远程电脑上创建 `.env` 文件：

```bash
# 远程网关配置
PLATFORM_URL=http://192.168.1.50:3000    # Agent Platform 地址
GATEWAY_ID=gateway-office-pc              # 网关唯一标识
GATEWAY_NAME=Office PC Gateway            # 网关名称
GATEWAY_PORT=8080                         # 网关端口
HEARTBEAT_INTERVAL=30000                  # 心跳间隔（毫秒）
```

#### Step 2: 运行注册脚本

**一次性注册**:
```bash
cd E:\projects\agent-platform-v2
node scripts/register-remote-gateway.js register
```

**守护进程模式（持续心跳）**:
```bash
node scripts/register-remote-gateway.js daemon
```

**后台运行（Windows）**:
```powershell
Start-Process node -ArgumentList "scripts/register-remote-gateway.js", "daemon" -WindowStyle Hidden
```

**后台运行（Linux/Mac）**:
```bash
nohup node scripts/register-remote-gateway.js daemon > gateway.log 2>&1 &
```

#### Step 3: 验证注册

访问 Agent Platform Dashboard：
```
http://localhost:3000
```

应该能看到：
- ✅ Remote Node 状态为 `online`
- ✅ Remote Agents 状态为 `online`

---

## 🔧 API 端点说明

### POST /api/nodes/register

远程网关自动注册端点。

#### 请求参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| action | string | ✅ | `register` / `heartbeat` / `unregister` |
| gatewayId | string | ✅ | 网关唯一标识 |
| name | string | ✅ | 网关名称 |
| ip | string | ✅ | 网关 IP 地址 |
| port | string | ✅ | 网关端口 |
| agents | array | ❌ | Agent 列表 |
| resources | object | ❌ | 资源信息 |

#### Agent 对象结构

```json
{
  "id": "agent-1",
  "name": "Coder Agent",
  "type": "coding",
  "capabilities": ["python", "typescript"],
  "status": "online"
}
```

#### 响应示例

**注册成功**:
```json
{
  "success": true,
  "node": {
    "id": "gateway-office-pc",
    "name": "Office PC Gateway",
    "ip": "192.168.1.100:8080",
    "status": "online"
  },
  "message": "Node and agents registered successfully"
}
```

**心跳成功**:
```json
{
  "success": true,
  "message": "Heartbeat received",
  "node": { ... }
}
```

---

## 🌐 网络配置

### 防火墙设置

确保 Agent Platform 服务器的防火墙允许远程网关访问：

**Windows (PowerShell)**:
```powershell
# 开放 3000 端口
New-NetFirewallRule -DisplayName "Agent Platform" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

**Linux (UFW)**:
```bash
sudo ufw allow 3000/tcp
```

### 局域网访问

如果远程网关在同一个局域网：
- 使用局域网 IP（如 `192.168.1.50`）
- 确保路由器没有隔离客户端

### 跨网络访问

如果远程网关在不同网络：
- 需要公网 IP 或内网穿透
- 可选方案：ngrok, frp, Cloudflare Tunnel

**ngrok 示例**:
```bash
ngrok http 3000
# 获取公网地址：https://xxx.ngrok.io
# 更新 PLATFORM_URL=https://xxx.ngrok.io
```

---

## 🔍 故障排查

### 问题 1: 注册失败 "Connection refused"

**原因**: Agent Platform 服务器不可达

**解决**:
1. 检查服务器是否运行：`curl http://localhost:3000`
2. 检查防火墙设置
3. 确认 IP 地址正确

### 问题 2: Agent 状态一直 offline

**原因**: 心跳未发送或 Node 未正确关联

**解决**:
1. 检查注册脚本是否运行
2. 查看日志：`node scripts/register-remote-gateway.js daemon`
3. 确认 `nodeId` 正确关联

### 问题 3: 心跳超时

**原因**: 网络延迟或服务器负载高

**解决**:
1. 增加心跳间隔：`HEARTBEAT_INTERVAL=60000`
2. 检查网络延迟：`ping <platform-ip>`
3. 优化服务器性能

---

## 📊 监控和维护

### 查看已注册网关

```bash
curl http://localhost:3000/api/nodes
```

### 查看已注册 Agent

```bash
curl http://localhost:3000/api/agents
```

### 手动下线网关

```bash
curl -X DELETE http://localhost:3000/api/nodes/<node-id>
```

---

## 🎯 最佳实践

1. **唯一标识**: 每个网关使用唯一的 `GATEWAY_ID`
2. **心跳间隔**: 建议 30-60 秒，避免过频
3. **优雅退出**: 关闭网关前发送 `unregister` 请求
4. **日志记录**: 保存注册脚本日志便于排查
5. **安全认证**: 生产环境添加 API Token 认证

---

## 📝 示例配置

### 家庭办公室场景

```bash
# 家庭服务器 (Agent Platform)
PLATFORM_URL=http://192.168.1.50:3000

# 公司电脑 (远程网关)
GATEWAY_ID=gateway-office
GATEWAY_NAME=Office Workstation
GATEWAY_PORT=8080

# 家里笔记本 (远程网关)
GATEWAY_ID=gateway-home-laptop
GATEWAY_NAME=Home Laptop
GATEWAY_PORT=8081
```

### 多机房场景

```bash
# 北京机房
GATEWAY_ID=gateway-beijing
GATEWAY_NAME=Beijing Datacenter

# 上海机房
GATEWAY_ID=gateway-shanghai
GATEWAY_NAME=Shanghai Datacenter

# 深圳机房
GATEWAY_ID=gateway-shenzhen
GATEWAY_NAME=Shenzhen Datacenter
```

---

## 🚀 下一步

- [ ] 添加 API Token 认证
- [ ] 实现网关自动发现（mDNS）
- [ ] 添加网关健康检查
- [ ] 支持网关负载均衡
