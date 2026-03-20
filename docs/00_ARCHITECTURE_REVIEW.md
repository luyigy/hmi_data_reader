# 跨网关 Agent 注册架构审查

**创建时间**: 2026-03-11 09:19  
**作者**: HK-vision  
**状态**: 设计审查 - 需要重构

---

## 📋 背景

用户提出需求：实现跨网关 Agent 注册，让其他 OpenClaw 实例的 Agent 能够注册到统一平台并相互通信。

---

## ✅ 已完成的工作

### 1. 自动注册 API (`src/app/api/nodes/register/route.ts`)

**功能**:
- ✅ POST `/api/nodes/register` 端点
- ✅ 支持 `register` / `heartbeat` / `unregister` 三种 action
- ✅ 自动创建/更新 Node 和关联 Agents

**问题**:
- ❌ **缺少认证机制** - 没有验证 Gateway Token
- ❌ **Node 模型错误** - Node 应该是 Gateway，不是被控制的对象
- ❌ **无法真正控制远程 Agent** - 只是在数据库创建记录

**代码片段**:
```typescript
// 当前实现 - 有问题
await prisma.node.create({
  data: {
    name,
    ip: `${ip}:${port}`,
    status: 'online',
  }
});
```

---

### 2. 注册脚本 (`scripts/register-remote-gateway.js`)

**功能**:
- ✅ 读取本地 `openclaw.json` 配置
- ✅ 自动获取系统资源和 Agent 列表
- ✅ 支持 `register` / `heartbeat` / `daemon` 三种模式
- ✅ 守护进程模式（每 30 秒心跳）
- ✅ 优雅退出处理（SIGINT）

**问题**:
- ❌ **没有使用 Gateway Token** - 无法通过 OpenClaw 认证
- ❌ **单向上报** - 只是推送数据，无法接收指令

**代码片段**:
```javascript
// 当前实现 - 缺少 Token
const response = await fetch(`${PLATFORM_URL}/api/nodes/register`, {
  method: 'POST',
  body: JSON.stringify({ action: 'register', ... })
});
```

---

### 3. 注册 UI (`src/components/dashboard/RemoteGatewayForm.tsx`)

**功能**:
- ✅ 两步向导式 UI（选择方式 → 填写信息）
- ✅ 手动配置模式（填写网关信息）
- ✅ 自动生成脚本模式
- ✅ 实时验证和错误提示
- ✅ 成功后自动刷新 Dashboard

**问题**:
- ❌ **没有 Token 输入字段** - 无法输入 Gateway Token
- ❌ **没有验证 Gateway 连接** - 无法测试 Token 是否有效

**UI 流程**:
```
Step 1: 选择注册方式
  ├─ 手动配置
  └─ 自动生成脚本

Step 2a: 手动配置
  ├─ 网关名称
  ├─ IP 地址
  ├─ 端口
  └─ Agent 列表
```

---

### 4. 独立注册页面 (`src/app/nodes/register/page.tsx`)

**功能**:
- ✅ 完整的注册流程页面
- ✅ 包含使用说明和文档链接
- ✅ 返回 Dashboard 导航

---

### 5. 使用文档 (`docs/CROSS_GATEWAY_REGISTRATION.md`)

**功能**:
- ✅ 完整架构说明
- ✅ 手动注册教程
- ✅ 自动注册教程
- ✅ 网络配置指南
- ✅ 故障排查手册

**问题**:
- ❌ **基于错误的架构** - 需要重写

---

### 6. Dashboard 集成 (`src/app/page.tsx`)

**功能**:
- ✅ 改为客户端渲染（use client）
- ✅ 添加实时数据刷新
- ✅ 集成注册模态框
- ✅ "注册远程网关"按钮

---

### 7. 数据库模型 (`prisma/schema.prisma`)

**当前模型**:
```prisma
model Node {
  id       String   @id
  name     String
  ip       String
  status   String
  agents   Agent[]
}

model Agent {
  id       String   @id
  name     String
  type     String
  location String   // local/remote
  nodeId   String?  // → Node.id
  status   String
}
```

**问题**:
- ❌ **Node 应该是 Gateway** - 包含 URL 和 Token
- ❌ **缺少 Gateway Token 字段** - 无法认证
- ❌ **缺少 Message 表** - 无法跨网关通信

---

## ❌ 核心架构问题

### 问题 1: 混淆了 Node 和 Gateway

**错误理解**:
```
Node = 远程电脑（被动被管理）
```

**正确理解**:
```
Gateway = OpenClaw 实例（主动控制 Agents）
Platform = 应用层（通过 Gateway API 间接控制 Agents）
```

### 问题 2: 缺少认证机制

OpenClaw Gateway 需要 Token 才能通信：
```bash
# 获取 Gateway Token
cat ~/.openclaw/openclaw.json
# 或
openclaw gateway token
```

当前实现完全没有 Token 验证，无法真正连接 Gateway。

### 问题 3: 无法真正控制远程 Agent

**当前实现**:
```
Platform → 数据库创建 Agent 记录 → ❌ 无法控制
```

**正确实现**:
```
Platform → Gateway API (带 Token) → Agent
```

### 问题 4: 没有跨网关通信

Agent 之间无法对话，因为：
- 没有消息路由机制
- 没有 Gateway 之间的通信协议
- 没有消息队列

---

## ✅ 正确的架构设计

### 核心思路

```
┌─────────────────────────────────────────────────────────────┐
│           Agent Platform (独立应用层 - 不是 Gateway)          │
│                                                              │
│  职责:                                                       │
│  1. 统一展示所有 Gateway 的 Agents                            │
│  2. 跨网关任务编排                                             │
│  3. Agent 之间的消息路由                                       │
│  4. 不直接控制 Agent，而是通过 Gateway API                     │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  统一数据库                                             │ │
│  │  - Gateways (网关元数据 + Token)                         │ │
│  │  - Agents (Agent 元数据 + 能力 + 所属 Gateway)             │ │
│  │  - Tasks (跨网关任务)                                    │ │
│  │  - Messages (跨网关消息队列)                              │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                          │
                          │ HTTPS + Gateway Token
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
        ▼                 ▼                 ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│ Gateway A     │ │ Gateway B     │ │ Gateway C     │
│ (OpenClaw)    │ │ (OpenClaw)    │ │ (OpenClaw)    │
│               │ │               │ │               │
│ Token: xxx    │ │ Token: yyy    │ │ Token: zzz    │
│               │ │               │ │               │
│ ┌───────────┐ │ │ ┌───────────┐ │ │ ┌───────────┐ │
│ │ Agent A1  │ │ │ │ Agent B1  │ │ │ │ Agent C1  │ │
│ │ Agent A2  │ │ │ │ Agent B2  │ │ │ │ Agent C2  │ │
│ └───────────┘ │ │ └───────────┘ │ │ └───────────┘ │
└───────────────┘ └───────────────┘ └───────────────┘
```

---

### 正确的注册流程

#### 步骤 1: 获取 Gateway Token

用户在远程 OpenClaw 实例上：
```bash
cat ~/.openclaw/openclaw.json
# 或
openclaw gateway token
```

获取：
```json
{
  "gatewayId": "gateway-office-pc",
  "token": "gwt_xxxxxxxxxxxxx"
}
```

#### 步骤 2: 在 Platform 注册

UI 输入：
- Gateway 名称：Office PC Gateway
- Gateway URL: http://192.168.1.100:8080
- Gateway Token: gwt_xxxxxxxxxxxxx

后端验证：
```typescript
// 1. 验证 Token
const response = await fetch(`${gatewayUrl}/api/gateway/status`, {
  headers: { 'Authorization': `Bearer ${token}` }
});

// 2. 获取 Agent 列表
const agents = await fetch(`${gatewayUrl}/api/agents`, {
  headers: { 'Authorization': `Bearer ${token}` }
});

// 3. 加密存储 Token
await prisma.gateway.create({
  data: {
    name,
    url: gatewayUrl,
    token: encrypt(token),
    agents: ...
  }
});
```

#### 步骤 3: 跨网关通信

发送任务：
```typescript
const agent = await prisma.agent.findUnique({
  where: { id: 'agent-b1' },
  include: { gateway: true }
});

await fetch(`${agent.gateway.url}/api/agents/execute`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${decrypt(agent.gateway.token)}`
  },
  body: JSON.stringify({
    agentId: agent.remoteId,
    task: '写一个 Python 函数'
  })
});
```

---

## 📝 需要改进的工作

### 优先级 1: 数据库模型重构

**任务**:
- [ ] 将 `Node` 表重命名为 `Gateway`
- [ ] 添加 `token` 字段（加密存储）
- [ ] 添加 `url` 字段（Gateway API 地址）
- [ ] 创建 `Message` 表（跨网关消息队列）
- [ ] 更新 `Agent` 表关联到 `Gateway`

**新模型**:
```prisma
model Gateway {
  id        String   @id @default(cuid())
  name      String
  url       String   // Gateway API 地址
  token     String   // 加密存储
  status    String   @default("offline")
  agents    Agent[]
  createdAt DateTime @default(now)
}

model Agent {
  id          String   @id @default(cuid())
  name        String
  type        String
  capabilities String  // JSON
  status      String   @default("offline")
  gatewayId   String   // 所属 Gateway
  gateway     Gateway  @relation(fields: [gatewayId], references: [id])
  tasks       Task[]
  messages    Message[]
}

model Message {
  id        String   @id @default(cuid())
  fromAgent String
  toAgent   String
  content   String
  status    String   // pending/sent/delivered/failed
  createdAt DateTime @default(now)
}
```

---

### 优先级 2: Gateway 注册 API 重构

**任务**:
- [ ] 重写 `/api/gateways/register`（替代 `/api/nodes/register`）
- [ ] 添加 Token 验证逻辑
- [ ] 添加 Gateway 连接测试
- [ ] 实现 Agent 列表同步
- [ ] 加密存储 Token

**新端点**:
```typescript
POST /api/gateways/register
Body: {
  name: string,
  url: string,
  token: string
}

Response: {
  success: boolean,
  gateway: Gateway,
  agents: Agent[]
}
```

---

### 优先级 3: 跨网关消息路由

**任务**:
- [ ] 创建 `/api/messages/send` 端点
- [ ] 实现消息持久化到数据库
- [ ] 实现消息转发到目标 Gateway
- [ ] 添加消息状态跟踪（pending/sent/delivered）
- [ ] 实现消息重试机制

**消息流**:
```
Agent A → Gateway A → Platform → Gateway B → Agent B
```

---

### 优先级 4: UI 重构

**任务**:
- [ ] 更新 `RemoteGatewayForm` 添加 Token 输入
- [ ] 添加 Gateway 连接测试按钮
- [ ] 显示 Gateway 状态（在线/离线）
- [ ] 显示 Agent 所属 Gateway
- [ ] 添加消息历史查看

**新 UI 流程**:
```
Step 1: 选择注册方式
  ├─ OpenClaw Gateway（带 Token）
  └─ 手动配置（无 Token，仅展示）

Step 2: 输入 Gateway 信息
  ├─ Gateway 名称
  ├─ Gateway URL
  ├─ Gateway Token ← 新增
  └─ 测试连接 ← 新增

Step 3: 同步 Agent 列表
  └─ 从 Gateway API 自动获取
```

---

### 优先级 5: 安全加固

**任务**:
- [ ] 加密存储所有 Gateway Tokens（使用 crypto 库）
- [ ] 添加 API 访问控制（Platform 自身的认证）
- [ ] 实现 Token 轮换机制
- [ ] 添加 Gateway 访问日志
- [ ] 实现速率限制

---

### 优先级 6: 文档更新

**任务**:
- [ ] 重写 `CROSS_GATEWAY_REGISTRATION.md`
- [ ] 添加 Gateway Token 获取教程
- [ ] 添加跨网关通信示例
- [ ] 添加安全最佳实践

---

## 📊 工作量评估

| 任务 | 复杂度 | 预计时间 |
|------|--------|---------|
| 数据库模型重构 | 中 | 1 小时 |
| Gateway 注册 API | 高 | 2-3 小时 |
| 跨网关消息路由 | 高 | 3-4 小时 |
| UI 重构 | 中 | 2 小时 |
| 安全加固 | 中 | 2 小时 |
| 文档更新 | 低 | 1 小时 |
| **总计** | - | **11-13 小时** |

---

## 🎯 下一步行动

### 阶段 1: 基础架构（本次会话）
1. ✅ 记录当前问题（本文档）
2. ⏳ 创建新的数据库模型
3. ⏳ 实现 Gateway 注册 API（带 Token 验证）

### 阶段 2: 消息路由（下次会话）
1. 实现跨网关消息队列
2. 实现消息转发逻辑
3. 测试端到端通信

### 阶段 3: UI 和安全（后续会话）
1. 更新 UI 支持 Token 输入
2. 实现 Token 加密存储
3. 添加访问控制和日志

---

## 📌 关键决策

1. **Platform 不直接控制 Agent** - 通过 Gateway API 间接控制
2. **Gateway Token 是核心** - 没有 Token 无法通信
3. **消息队列是必需的** - 异步跨网关通信
4. **加密存储 Token** - 安全要求

---

## 🔗 相关资源

- OpenClaw 文档：https://docs.openclaw.ai
- OpenClaw Gateway API：待查阅
- 项目路径：`E:\projects\agent-platform-v2`

---

**最后更新**: 2026-03-11 09:19
