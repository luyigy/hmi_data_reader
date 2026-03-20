# Control Plane 架构设计

**创建时间**: 2026-03-19 23:35  
**项目**: Agent Platform v2  
**版本**: 1.0

---

## 🎯 设计目标

在现有 Gateway 架构基础上，增加 Control Plane 功能，实现：

1. **多 Gateway 编排** - 统一管理多个 Gateway 的状态和任务分配
2. **飞书命令集成** - 通过飞书群聊命令控制 Gateway 和 Agent
3. **负载均衡** - 智能分配任务到最优 Gateway
4. **故障恢复** - Gateway 离线时自动切换

---

## 🏗️ 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    Feishu Chat Room                     │
│  (User sends: "@Agent Platform 执行任务 XYZ")           │
└────────────────────┬────────────────────────────────────┘
                     │ Webhook / Polling
                     ▼
┌─────────────────────────────────────────────────────────┐
│              FeishuCommandRouter                        │
│  - Parse command from Feishu message                    │
│  - Extract intent and parameters                        │
│  - Route to appropriate Gateway                         │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│                 GatewayManager                          │
│  - Maintain Gateway registry                            │
│  - Monitor Gateway health (heartbeat)                   │
│  - Load balancing across Gateways                       │
│  - Failover handling                                    │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│                GatewayClient                            │
│  - Encapsulate Gateway API calls                        │
│  - Handle authentication (Token)                        │
│  - Send/Receive messages                                │
│  - WebSocket connection management                      │
└────────────────────┬────────────────────────────────────┘
                     │ HTTP / WebSocket
                     ▼
┌─────────────────────────────────────────────────────────┐
│              Remote Gateway(s)                          │
│  - Gateway A (192.168.1.100:3000)                       │
│  - Gateway B (192.168.1.101:3000)                       │
│  - Gateway C (Cloud)                                    │
└─────────────────────────────────────────────────────────┘
```

---

## 📦 核心组件

### 1. GatewayClient

**职责**: 封装与单个 Gateway 的通信

**文件位置**: `src/lib/control-plane/GatewayClient.ts`

**接口定义**:
```typescript
interface GatewayClient {
  // 连接管理
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  
  // 认证
  authenticate(token: string): Promise<boolean>;
  
  // 消息发送
  sendMessage(payload: Record<string, unknown>): Promise<SendResult>;
  
  // 消息接收
  onMessage(callback: (message: Message) => void): void;
  
  // 健康检查
  heartbeat(): Promise<HeartbeatResult>;
  
  // Gateway 信息
  getGatewayInfo(): Promise<GatewayInfo>;
}
```

**实现要点**:
- 使用现有 `gateway-auth.ts` 进行 Token 认证
- 使用现有 `gateway-router.ts` 发送消息
- 支持 HTTP 和 WebSocket 两种连接方式
- 自动重连机制

---

### 2. GatewayManager

**职责**: 管理多个 GatewayClient，实现编排和负载均衡

**文件位置**: `src/lib/control-plane/GatewayManager.ts`

**接口定义**:
```typescript
interface GatewayManager {
  // Gateway 注册
  registerGateway(gateway: GatewayConfig): Promise<void>;
  unregisterGateway(gatewayId: string): Promise<void>;
  
  // Gateway 状态
  getGatewayStatus(gatewayId: string): Promise<GatewayStatus>;
  getAllGateways(): Promise<GatewayInfo[]>;
  
  // 任务分配
  assignTask(task: Task): Promise<AssignmentResult>;
  broadcastTask(task: Task): Promise<BroadcastResult>;
  
  // 负载均衡
  selectBestGateway(criteria?: SelectionCriteria): Promise<string>;
  
  // 健康监控
  startHealthCheck(intervalMs?: number): void;
  stopHealthCheck(): void;
}
```

**实现要点**:
- 维护 Gateway 注册表（内存 + 数据库持久化）
- 定期心跳检测（默认 30 秒）
- 负载均衡策略：
  - Round Robin
  - Least Loaded
  - Latency-based
- 故障检测和自动切换

**数据库扩展**:
```prisma
model ControlPlaneState {
  id              String   @id @default(cuid())
  gatewayId       String   @unique
  status          String   // online, offline, unhealthy, maintenance
  lastHeartbeat   DateTime @default(now())
  loadScore       Float    @default(0) // 0-100, lower is better
  latency         Int      @default(0) // ms
  consecutiveFails Int     @default(0)
  metadata        String?  // JSON
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([status])
}
```

---

### 3. FeishuCommandRouter

**职责**: 解析飞书消息，路由到合适的 Gateway

**文件位置**: `src/lib/control-plane/FeishuCommandRouter.ts`

**接口定义**:
```typescript
interface FeishuCommandRouter {
  // 命令解析
  parseCommand(message: FeishuMessage): Promise<ParsedCommand>;
  
  // 命令路由
  routeCommand(command: ParsedCommand): Promise<RouteResult>;
  
  // 命令注册
  registerHandler(command: string, handler: CommandHandler): void;
  
  // 启动监听
  startListener(): void;
  stopListener(): void;
}
```

**命令格式**:
```
@Agent Platform <command> [options] [args]

示例:
@Agent Platform execute --gateway=gateway-1 "分析代码库"
@Agent Platform broadcast "同步配置"
@Agent Platform status
@Agent Platform assign @Agent Alpha "修复 Bug #123"
```

**内置命令**:
| 命令 | 说明 | 示例 |
|------|------|------|
| `execute` | 执行任务到指定 Gateway | `execute --gateway=gw-1 "任务描述"` |
| `broadcast` | 广播到所有 Gateway | `broadcast "同步消息"` |
| `status` | 查询 Gateway 状态 | `status` |
| `assign` | 分配任务给 Agent | `assign @Agent Alpha "任务"` |
| `list` | 列出所有 Gateway | `list` |
| `health` | 健康检查 | `health` |

**实现要点**:
- 使用 Feishu Webhook 或轮询接收消息
- 命令解析使用正则或 CLI 解析库
- 集成现有 `gateway-auth.ts` 验证发送者权限
- 支持命令别名和快捷方式

---

## 🔐 安全设计

### 认证流程

```
Feishu User → FeishuCommandRouter → GatewayManager → GatewayClient → Remote Gateway
     │                                    │                                  │
     │                                    │                                  │
     └───── Feishu Token ────────────────┼──────────────────────────────────┤
                                          │                                  │
                                          └──── Gateway Token ───────────────┘
```

**双层认证**:
1. **Feishu 层**: 验证消息来自合法的飞书用户/应用
2. **Gateway 层**: 验证 Control Plane 有权限访问 Gateway

### Token 管理

- Feishu Token: 由飞书应用管理，验证用户身份
- Gateway Token: 现有 AES-256-GCM 加密存储
- Control Plane 维护 Gateway Token 缓存（内存，不持久化）

---

## 🔄 通信协议

### Control Plane → Gateway

**HTTP REST API** (使用现有端点):
```
POST /api/gateways/messages/incoming
Headers:
  Authorization: Bearer <gateway-token>
  Content-Type: application/json

Body:
{
  "fromGatewayId": "control-plane",
  "message": {
    "type": "command",
    "command": "execute",
    "payload": { ... }
  },
  "type": "direct"
}
```

**WebSocket** (可选优化):
```
ws://gateway-url/api/socket
Events:
  - cp:command (Control Plane → Gateway)
  - cp:heartbeat (Control Plane → Gateway)
  - gw:response (Gateway → Control Plane)
  - gw:heartbeat (Gateway → Control Plane)
```

### Gateway → Control Plane

**响应格式**:
```json
{
  "success": true,
  "gatewayId": "gateway-1",
  "result": { ... },
  "timestamp": "2026-03-19T23:35:00Z"
}
```

**错误格式**:
```json
{
  "success": false,
  "error": {
    "code": "GATEWAY_OFFLINE",
    "message": "Gateway is not responding"
  },
  "gatewayId": "gateway-1",
  "timestamp": "2026-03-19T23:35:00Z"
}
```

---

## 📊 负载均衡策略

### 1. Round Robin (默认)
```typescript
selectGateway(): string {
  const available = this.getAvailableGateways();
  return available[this.currentIndex++ % available.length];
}
```

### 2. Least Loaded
```typescript
selectGateway(): string {
  const available = this.getAvailableGateways();
  return available.reduce((best, current) => 
    current.loadScore < best.loadScore ? current : best
  );
}
```

### 3. Latency-based
```typescript
selectGateway(): string {
  const available = this.getAvailableGateways();
  return available.reduce((best, current) => 
    current.latency < best.latency ? current : best
  );
}
```

---

## 🐛 故障恢复

### Gateway 离线检测

```typescript
class GatewayManager {
  private async healthCheck() {
    for (const gateway of this.gateways) {
      try {
        await this.clients.get(gateway.id)!.heartbeat();
        gateway.consecutiveFails = 0;
        gateway.status = 'online';
      } catch (error) {
        gateway.consecutiveFails++;
        
        if (gateway.consecutiveFails >= 3) {
          gateway.status = 'offline';
          await this.handleFailover(gateway);
        }
      }
    }
  }
}
```

### Failover 策略

1. **检测**: 连续 3 次心跳失败标记为 offline
2. **切换**: 将任务重新分配给次优 Gateway
3. **通知**: 发送告警到飞书群聊
4. **恢复**: Gateway 恢复后自动重新加入轮询

---

## 📁 文件结构

```
E:\projects\agent-platform-v2\src\lib\control-plane\
├── index.ts                      # 导出所有组件
├── GatewayClient.ts              # Gateway 客户端
├── GatewayManager.ts             # Gateway 编排器
├── FeishuCommandRouter.ts        # 飞书命令路由
├── types.ts                      # TypeScript 类型定义
├── constants.ts                  # 常量配置
└── utils/
    ├── load-balancer.ts          # 负载均衡工具
    ├── health-check.ts           # 健康检查工具
    └── retry.ts                  # 重试工具
```

---

## 🔜 实施顺序

1. **Step 3**: 实现 GatewayClient (基础通信)
2. **Step 4**: 实现 GatewayManager (编排逻辑)
3. **Step 5**: 实现 FeishuCommandRouter (命令解析)
4. **Step 6**: 集成测试和验证

---

## 📝 不确定项 (待验证)

1. **FeishuCommandRouter 部署位置**:
   - 方案 A: 集成到现有 Next.js 应用（作为 API Route）
   - 方案 B: 独立 Node.js 服务
   - **推荐**: 方案 A（简化部署，复用现有认证）

2. **Control Plane 与 Gateway 通信协议**:
   - 方案 A: 使用现有 HTTP REST API
   - 方案 B: 新增 WebSocket 长连接
   - **推荐**: 方案 A（复用现有端点，后续可优化）

3. **GatewayClient 连接管理**:
   - 方案 A: 按需创建连接
   - 方案 B: 预创建连接池
   - **推荐**: 方案 A（Gateway 数量有限，无需连接池）

---

**最后更新**: 2026-03-19 23:35  
**下次审查**: Step 6 集成测试时
