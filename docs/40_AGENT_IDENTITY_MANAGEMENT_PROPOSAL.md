# 40 Agent 身份管理方案

## 日期
2026-03-26

## 问题背景

当多个 gateway/server 上都有名为 `claude` 或 `codex` 的 agent 时，虽然系统会添加前缀（如 "Platform Local Claude"、"Linux Gateway 10.0.8.4 / main"），但仍存在以下问题：

1. **名称冗长**：完整的 gateway + agent 名太长，在 Live Room 中不便 @提及
2. **难以区分**：多个 "Claude" agent 在视觉上难以快速区分
3. **提及困难**：用户需要记住完整名称才能准确 @提及
4. **无个性化**：无法为 agent 设置符合其角色的昵称

## 当前命名机制分析

### 数据模型

```prisma
// Gateway
model Gateway {
  id   String @id @default(cuid())
  name String  // 例如: "Linux Gateway", "Windows Server"
}

// Agent (来自 Gateway)
model Agent {
  id             String
  name           String  // Gateway 上的名称，如 "claude"
  runtimeAgentId String? // 实际运行时 ID，如 "claude"
}

// LiveRoomMember
model LiveRoomMember {
  displayName       String   // 显示名称，如 "Platform Local Claude"
  agentNameSnapshot  String?  // agent 名称快照
  harnessType       String?  // "claude", "codex" 等
  roleLabel         String?  // 角色标签
}
```

### 当前命名逻辑

```typescript
// platform_local
agentName: "Platform Local Claude"  // gatewayName + " " + toTitleCase(harnessType)

// gateway_openclaw
agentName: agent.name  // 使用 Gateway 返回的名称

// remote_ssh
agentName: `${host.label} ${toTitleCase(harnessType)}`  // "Linux Gateway Claude"
```

### 问题示例

| Gateway | Agent Type | 当前显示名称 | 问题 |
|---------|-----------|-------------|------|
| Platform Local | claude | "Platform Local Claude" | 名称较长 |
| Linux Gateway 10.0.8.4 | main | "main" / "Linux Gateway 10.0.8.4 / main" | 不一致 |
| Windows Server | claude | "Windows Server Claude" | 与 Platform Local Claude 混淆 |
| GPU Server | codex | "GPU Server Codex" | 多个 Codex 难以区分 |

---

## 解决方案：多层命名系统

### 方案概览

引入三层命名结构：

```
技术ID (Technical ID)
    ↓
显示名称 (Display Name)
    ↓
用户昵称 (User Nickname) ← 用户可自定义
```

### 层级说明

| 层级 | 字段名 | 示例 | 可编辑性 | 用途 |
|------|--------|------|----------|------|
| **Technical ID** | `agentKey` | `platform-local:claude` | 系统生成 | 内部唯一标识 |
| **Display Name** | `displayName` | "Claude (本地)" | 系统生成，可调整 | UI 默认显示 |
| **Nickname** | `userNickname` | "小C", "代码专家" | 用户自定义 | Live Room 中使用 |

---

## 数据库扩展

### 新增字段

```prisma
// Agent 表扩展
model Agent {
  id               String    @id @default(cuid())
  name             String              // 原始名称
  runtimeAgentId   String?
  type             String

  // 新增字段
  userNickname     String?             // 用户自定义昵称
  roleDescription  String?             // 角色描述，如 "代码审查专家"
  colorTag         String?             // 颜色标签，用于 UI 区分
  emojiIcon        String?             // 表情图标，如 "🤖", "🧠"

  // ... 其他字段
}

// LiveRoomMember 表扩展
model LiveRoomMember {
  displayName      String
  agentNameSnapshot String?

  // 新增字段
  userNickname     String?             // 该 room 内的昵称（可选）
  shortAlias       String?             // 简短别名，用于 @提及

  // ... 其他字段
}
```

---

## Agent 管理功能

### 功能 1: Agent 管理页面

创建 `/agents` 管理页面，支持：

1. **查看所有 Agent**
   - 按分组展示 (Platform Local, Gateway, Remote SSH)
   - 显示 agent 状态、类型、所属 gateway
   - 颜色标签区分

2. **编辑 Agent 信息**
   ```typescript
   interface AgentEditForm {
     userNickname: string;      // "小C"
     roleDescription: string;   // "前端开发专家"
     colorTag: string;          // "#FF6B6B"
     emojiIcon: string;         // "🤖"
   }
   ```

3. **批量操作**
   - 导入/导出 agent 配置
   - 批量设置颜色标签

### 功能 2: 智能命名建议

系统自动生成易区分的名称：

```typescript
// 命名规则
const generateDisplayName = (agent: Agent): string => {
  const harnessType = agent.type; // "claude", "codex"
  const gatewayName = agent.gateway?.name;

  // 如果只有一个该类型的 agent
  if (countAgentsByType(harnessType) === 1) {
    return toTitleCase(harnessType); // "Claude"
  }

  // 多个同类型 agent，添加区分
  const gatewayShort = gatewayName?.split(' ')[0]; // "Linux" from "Linux Gateway"
  return `${toTitleCase(harnessType)} (${gatewayShort})`;
  // "Claude (Linux)", "Claude (Windows)"
};

// 生成简短别名（用于 @提及）
const generateShortAlias = (displayName: string): string => {
  // "Claude (本地)" -> "本地Claude" 或 "local-claude"
  // 支持中英文
};
```

### 功能 3: Live Room 内的昵称

允许在特定 Live Room 内为 agent 设置房间专属昵称：

```typescript
// LiveRoomMember.roomNickname
// 例如：在 "代码审查" 房间内，"Platform Local Claude" 的昵称是 "审查员"
```

---

## 提及 (@Mention) 改进

### 改进 1: 智能别名匹配

```typescript
// 匹配规则（优先级从高到低）
const mentionMatchPriority = [
  // 1. 精确匹配昵称
  { pattern: /@(\w+)/, source: 'userNickname' },

  // 2. 精确匹配短别名
  { pattern: /@([\w-]+)/, source: 'shortAlias' },

  // 3. 精确匹配显示名称
  { pattern: /@([^:]+)/, source: 'displayName' },

  // 4. 模糊匹配（首字母缩写）
  { pattern: /@([A-Z]{2,})/, source: 'initials' },
];
```

### 改进 2: 提及时显示完整信息

```
用户输入: @小C

系统显示:
┌─────────────────────────────────────┐
│ @小C                                 │
│ Platform Local Claude                │
│ 本地 · claude · 🟢 在线              │
└─────────────────────────────────────┘
```

### 改进 3: Tab 自动补全

```typescript
// 输入 @ 后显示候选列表
@<Tab>
┌─────────────────────────────┐
│ 🤖 小C   - Platform Local    │
│ 🧠 Claude专家 - Linux Gateway│
│ 💻 Codex - GPU Server        │
└─────────────────────────────┘
```

---

## UI/UX 设计

### Agent 卡片设计

```
┌──────────────────────────────────────┐
│ 🤖 小C                   🟢 在线     │
│ Platform Local Claude                │
│                                      │
│ 角色: 前端开发专家                    │
│ Gateway: Platform Local              │
│ Harness: Claude Code CLI             │
│                                      │
│ [编辑昵称] [设置颜色] [查看详情]      │
└──────────────────────────────────────┘
```

### Live Room 中的 Agent 显示

```
消息列表:
┌──────────────────────────────────────┐
│ 你  @小C 请帮我写一个 React 组件     │
│                                      │
│ ──────────────────────────────────   │
│                                      │
│ 🤖 小C (Platform Local Claude)       │
│ 好的，我来帮你写这个组件...           │
└──────────────────────────────────────┘

侧边栏成员列表:
┌──────────────────────────────────────┐
│ 🤖 小C                               │
│    Platform Local · claude            │
│                                      │
│ 🧠 Claude专家                        │
│    Linux Gateway · main               │
│                                      │
│ 💻 GPU-Codex                         │
│    GPU Server · codex                 │
└──────────────────────────────────────┘
```

---

## 实施计划

### Phase 1: 数据库扩展 (1-2 天)

- [ ] 添加 `Agent.userNickname`, `Agent.roleDescription`, `Agent.colorTag`, `Agent.emojiIcon`
- [ ] 添加 `LiveRoomMember.userNickname`, `LiveRoomMember.shortAlias`
- [ ] 数据库迁移脚本

### Phase 2: 命名逻辑改进 (2-3 天)

- [ ] 实现智能命名生成函数
- [ ] 更新 `deriveGatewayHarnessOptions` 使用新命名
- [ ] 更新 LiveRoom member 创建逻辑

### Phase 3: Agent 管理页面 (3-5 天)

- [ ] 创建 `/agents` 管理页面
- [ ] Agent 列表展示
- [ ] Agent 编辑表单
- [ ] 昵称/颜色/图标设置

### Phase 4: 提及机制改进 (2-3 天)

- [ ] 实现智能别名匹配
- [ ] Tab 自动补全
- [ ] 提及预览 UI

### Phase 5: Live Room 集成 (2-3 天)

- [ ] Live Room 内昵称设置
- [ ] UI 更新显示昵称
- [ ] 提及优先级使用昵称

---

## 示例配置

### 默认配置

```json
{
  "agents": [
    {
      "agentKey": "platform-local:claude",
      "displayName": "Claude (本地)",
      "userNickname": null,
      "colorTag": "#4A90E2",
      "emojiIcon": "🤖"
    },
    {
      "agentKey": "linux-gateway:claude",
      "displayName": "Claude (Linux)",
      "userNickname": null,
      "colorTag": "#50E3C2",
      "emojiIcon": "🧠"
    },
    {
      "agentKey": "gpu-server:codex",
      "displayName": "Codex (GPU)",
      "userNickname": null,
      "colorTag": "#F5A623",
      "emojiIcon": "💻"
    }
  ]
}
```

### 用户自定义后

```json
{
  "agents": [
    {
      "agentKey": "platform-local:claude",
      "displayName": "Claude (本地)",
      "userNickname": "小C",
      "roleDescription": "前端开发专家",
      "colorTag": "#4A90E2",
      "emojiIcon": "🎨"
    },
    {
      "agentKey": "linux-gateway:claude",
      "displayName": "Claude (Linux)",
      "userNickname": "老王",
      "roleDescription": "后端架构师",
      "colorTag": "#50E3C2",
      "emojiIcon": "🏗️"
    },
    {
      "agentKey": "gpu-server:codex",
      "displayName": "Codex (GPU)",
      "userNickname": "快快",
      "roleDescription": "高性能计算专家",
      "colorTag": "#F5A623",
      "emojiIcon": "⚡"
    }
  ]
}
```

---

## API 设计

### 获取 Agent 列表

```http
GET /api/agents
Response:
{
  "agents": [
    {
      "id": "agent_123",
      "agentKey": "platform-local:claude",
      "displayName": "Claude (本地)",
      "userNickname": "小C",
      "roleDescription": "前端开发专家",
      "colorTag": "#4A90E2",
      "emojiIcon": "🎨",
      "status": "online",
      "gateway": {
        "id": "platform-local",
        "name": "Platform Local"
      },
      "harnessType": "claude"
    }
  ]
}
```

### 更新 Agent 信息

```http
PATCH /api/agents/:id
Body:
{
  "userNickname": "小C",
  "roleDescription": "前端开发专家",
  "colorTag": "#4A90E2",
  "emojiIcon": "🎨"
}
```

### 设置 Live Room 内昵称

```http
PATCH /api/live-rooms/:roomId/members/:memberId
Body:
{
  "userNickname": "审查员",
  "shortAlias": "reviewer"
}
```

---

## 注意事项

1. **向后兼容**
   - 保留原有的 `displayName` 作为默认值
   - 新增字段为可选，现有系统继续工作

2. **唯一性保证**
   - `agentKey` 在系统内唯一
   - `userNickname` 在同一 Live Room 内唯一
   - `shortAlias` 全局唯一（或使用 `@gateway:nickname` 格式）

3. **性能考虑**
   - Agent 列表缓存
   - 昵称解析缓存

4. **国际化支持**
   - 昵称支持中文
   - 显示名称根据用户语言偏好调整
