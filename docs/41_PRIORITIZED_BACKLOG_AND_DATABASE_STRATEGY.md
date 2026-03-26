# 41 优先级待办事项与数据库策略

## 日期
2026-03-26

## 文档目的

整合本次讨论的所有问题和改进方向，按优先级排序，并包含数据库选型策略。

---

## 第一部分：数据库策略

### 当前状态

- **开发环境**: SQLite (`dev.db`, 4.5MB)
- **生产环境**: 未定

### SQLite 的优缺点分析

| 优点 | 缺点 |
|------|------|
| ✅ 零配置，开箱即用 | ❌ 单文件，单点故障 |
| ✅ 开发方便，可版本控制 | ❌ 并发写入受限 |
| ✅ 轻量级，资源占用低 | ❌ 大数据量性能下降 |
| ✅ 跨平台 | ❌ 不支持水平扩展 |

### 聊天历史数据特点分析

```
LiveRoomMessage:
  - 写入频率: 高 (每次对话)
  - 读取频率: 高 (加载历史)
  - 数据增长: 持续增长
  - 查询模式: 按时间排序、分页查询
  - 保留需求: 长期归档

TaskRunEvent:
  - 写入频率: 极高 (每个事件流)
  - 读取频率: 中 (任务执行查看)
  - 数据增长: 快速增长
  - 查询模式: 按 taskRunId + sequence
  - 保留需求: 短期 (任务完成后可归档)
```

### 推荐方案：混合数据库架构

```
┌─────────────────────────────────────────────────────────┐
│                    应用层                                 │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────────┐      ┌──────────────────────┐    │
│  │  热数据 (活跃)    │      │  冷数据 (归档)         │    │
│  │  PostgreSQL     │  →   │  时序数据库/对象存储    │    │
│  │                 │      │  (InfluxDB/S3)        │    │
│  └──────────────────┘      └──────────────────────┘    │
│         ↓                                                 │
│  ┌──────────────────┐                                    │
│  │  元数据          │                                    │
│  │  PostgreSQL      │                                    │
│  │                 │                                    │
│  │  - User          │                                    │
│  │  - Gateway       │                                    │
│  │  - LiveRoom      │                                    │
│  │  - Task          │                                    │
│  └──────────────────┘                                    │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 分阶段迁移计划

#### Phase 1: 开发阶段 (当前)

```env
# .env
DATABASE_URL="file:./dev.db"  # SQLite
```

**保持 SQLite，添加开发辅助**:
- 添加数据库清理脚本
- 添加数据导出/导入功能
- 监控数据库大小

#### Phase 2: 生产准备 (1-2 周)

```env
# .env.production
DATABASE_URL="postgresql://user:pass@localhost:5432/agent_platform"
```

**迁移到 PostgreSQL**:
- 使用 Prisma 迁移工具
- 支持 Docker Compose 部署
- 数据库连接池配置

#### Phase 3: 数据归档 (长期)

**自动归档策略**:

```typescript
// 归档配置
const ARCHIVE_CONFIG = {
  // Live Room 消息：30 天后归档
  liveRoomMessages: { days: 30, archiveTo: 'cold_storage' },

  // Task Run 事件：7 天后归档
  taskRunEvents: { days: 7, archiveTo: 'cold_storage' },

  // 完成的 Task：90 天后归档
  completedTasks: { days: 90, archiveTo: 'cold_storage' },
};
```

### 具体实施方案

#### 方案 A: 全 PostgreSQL (推荐起步)

**优点**:
- 成熟稳定
- 生态丰富
- 迁移成本低
- 支持全文搜索

**配置**:

```prisma
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: agent_platform
      POSTGRES_USER: agent
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

volumes:
  postgres_data:
```

#### 方案 B: PostgreSQL + 时序数据库 (大规模)

**优点**:
- 热数据查询快
- 冷数据成本低
- 支持高写入吞吐

**适用场景**:
- 日活用户 > 1000
- 日消息量 > 100,000
- 需要长期保留历史

```typescript
// 写入时自动路由
const writeEvent = async (event: TaskRunEvent) => {
  // 热数据写入 PostgreSQL
  await prisma.taskRunEvent.create({ data: event });

  // 异步复制到时序数据库
  await influxClient.write({
    measurement: 'task_events',
    tags: { taskRunId: event.taskRunId },
    fields: { content: event.content },
  });
};
```

### 数据库选择决策树

```
你的场景是什么？

├─ 开发/测试
│  └─ → SQLite (当前)
│
├─ 小规模生产 (< 100 用户)
│  └─ → PostgreSQL (单机)
│
├─ 中等规模 (100-1000 用户)
│  └─ → PostgreSQL + 连接池 + 读写分离
│
└─ 大规模 (> 1000 用户)
   └─ → PostgreSQL + 消息队列 + 冷存储
```

### 立即可做的改进

```typescript
// scripts/db-cleanup.ts
// 清理旧数据，控制 SQLite 大小

import { prisma } from '@/lib/prisma';

const cleanupOldMessages = async (daysToKeep = 90) => {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

  const deleted = await prisma.liveRoomMessage.deleteMany({
    where: {
      createdAt: { lt: cutoffDate },
      room: { status: 'archived' },  // 只删除已归档房间的消息
    },
  });

  console.log(`Deleted ${deleted.count} old messages`);
};
```

---

## 第二部分：优先级待办事项

### P0 - 紧急修复 (本周完成)

| ID | 任务 | 描述 | 预计时间 | 文件 | 状态 |
|----|------|------|----------|------|------|
| P0-1 | **修复 @提及匹配逻辑** | 短名称优先于长名称匹配，导致提及不准确 | 2-3h | `src/lib/live-room.ts:205-280` | ✅ 完成 |
| P0-2 | **防止 Agent 回复触发连锁** | Agent 回复内容被检测提及，触发其他 agent | 2h | `src/lib/live-room.ts:1032-1055`, `src/lib/live-room-delivery.ts:655-695` | ✅ 完成 |
| P0-3 | **Windows Claude CLI 修复** | 已完成，验证测试 | 1h | `src/lib/real-agents/claude-agent.ts` | ✅ 完成 |

#### P0 完成详情

**P0-1: 修复 @提及匹配逻辑**
- 新增 `MentionMatchResult` 接口，包含 `index`, `matchedAlias`, `matchedLength`
- `findBestExplicitMentionMatch` 和 `findBestPlainMentionMatch` 优先选择最长匹配
- 当多个匹配位置相同时，按匹配长度降序排序（更精确的优先）
- 添加 `DEBUG_MENTION_DETECTION` 环境变量用于调试

**P0-2: 防止 Agent 回复触发连锁**
- `resolveLiveRoomMessageMetadata` 中，agent 消息的 @提及默认设为 `broadcast`（不触发自动回复）
- 只有明确的 `handoff` 或 `ask` 模式才会触发连锁回复
- 更新 `live-room-delivery.ts` 中的连锁提及检查逻辑

**P0-3: Windows Claude CLI 修复**
- 添加 `shell: process.platform === 'win32'` 兼容 Windows
- Linux 保持 `shell: false` 不受影响

### P1 - 核心功能 (2 周内)

| ID | 任务 | 描述 | 预计时间 | 依赖 |
|----|------|------|----------|------|
| P1-1 | **数据库迁移到 PostgreSQL** | 生产环境数据库准备 | 1-2天 | - |
| P1-2 | **Agent 身份管理 - Phase 1** | 数据库扩展（昵称字段） | 1天 | P1-1 |
| P1-3 | **智能命名生成** | 自动生成易区分的 agent 名称 | 1天 | P1-2 |
| P1-4 | **@提及调试功能** | 添加日志和 UI 显示 | 0.5天 | - |
| P1-5 | **ACPX event stream UI** | Live Room 直接消费 ACPX 事件 | 2-3天 | - |

### P2 - 重要增强 (1 个月内)

| ID | 任务 | 描述 | 预计时间 | 依赖 |
|----|------|------|----------|------|
| P2-1 | **Agent 管理页面** | `/agents` 管理界面 | 3-5天 | P1-2, P1-3 |
| P2-2 | **提及 Tab 自动补全** | 输入 @ 后显示候选列表 | 2-3天 | P2-1 |
| P2-3 | **Live Room → Task Run 桥接** | `/create-task` 系统命令 | 2天 | - |
| P2-4 | **Remote session daemon 模式** | 长期常驻的 remote agent | 3-5天 | - |
| P2-5 | **数据归档机制** | 自动归档旧数据 | 2天 | P1-1 |

### P3 - 长期优化 (后续迭代)

| ID | 任务 | 描述 | 预计时间 |
|----|------|------|----------|
| P3-1 | **Gateway OpenClaw continuation** | 纳入统一 continuation 语义 | 3-5天 |
| P3-2 | **时序数据库集成** | 大规模消息存储优化 | 1周 |
| P3-3 | **全文搜索** | 聊天历史和任务搜索 | 2-3天 |
| P3-4 | **多语言支持** | Agent 界面国际化 | 3-5天 |

---

## 第三部分：技术债务清单

### 需要重构的代码

| 文件/模块 | 问题 | 优先级 |
|-----------|------|--------|
| `src/lib/live-room.ts` | 提及检测逻辑复杂，难以调试 | P0 |
| `src/lib/live-room-delivery.ts` | 连锁提及处理逻辑混乱 | P0 |
| `src/lib/acpx/runner.ts` | 错误处理不完善 | P1 |
| `src/app/api/live-rooms/**` | API 响应格式不统一 | P2 |

### 需要补充的测试

| 模块 | 测试类型 | 优先级 |
|------|----------|--------|
| `detectMentionedLiveRoomMembers` | 单元测试 | P0 |
| `executeLiveRoomReplyViaAcpx` | 集成测试 | P1 |
| Agent 管理功能 | E2E 测试 | P2 |

---

## 第四部分：本周行动计划

### Day 1-2: P0 修复

```bash
# 1. 修复 @提及匹配
#    - 优先最长匹配
#    - 添加调试日志

# 2. 防止连锁反应
#    - 区分用户消息和 Agent 消息
#    - Agent 消息不触发新回复

# 3. 验证 Windows Claude CLI
#    - 测试 spawn 是否正常
#    - 测试 continuation 是否工作
```

### Day 3-4: P1-1 数据库迁移

```bash
# 1. 设置 PostgreSQL (Docker)
# 2. Prisma 迁移
# 3. 数据导入测试
# 4. 更新 .env.example
```

### Day 5: P1-2 Agent 身份管理 Phase 1

```bash
# 1. 设计数据库 schema
# 2. 创建迁移
# 3. 更新相关类型定义
```

---

## 第五部分：相关文档索引

| 文档 | 内容 |
|------|------|
| [38_ACPX_LIVE_ROOM_PLAN_C_BRIDGE_FOUNDATION_HANDOVER.md](./38_ACPX_LIVE_ROOM_PLAN_C_BRIDGE_FOUNDATION_HANDOVER.md) | ACPX 桥接已完成功能 |
| [39_WINDOWS_PLATFORM_CLAUDE_FIX_AND_NEXT_PLAN.md](./39_WINDOWS_PLATFORM_CLAUDE_FIX_AND_NEXT_PLAN.md) | Windows 修复和提及问题分析 |
| [40_AGENT_IDENTITY_MANAGEMENT_PROPOSAL.md](./40_AGENT_IDENTITY_MANAGEMENT_PROPOSAL.md) | Agent 身份管理完整方案 |
| [WINDOWS_SETUP_HANDOVER.md](./WINDOWS_SETUP_HANDOVER.md) | Windows 服务器配置 |

---

## 第六部分：快速参考

### 环境变量模板

```env
# .env.example

# 数据库 (开发用 SQLite，生产用 PostgreSQL)
DATABASE_URL="file:./dev.db"
# DATABASE_URL="postgresql://user:pass@localhost:5432/agent_platform"

# 端口
PORT=3010
SOCKET_PORT=3011
NEXT_PUBLIC_SOCKET_PORT=3011

# WebSocket (可选)
# NEXT_PUBLIC_SOCKET_URL=http://localhost:3010
```

### Docker Compose 模板

```yaml
# docker-compose.yml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "3010:3010"
    environment:
      DATABASE_URL: postgresql://agent:password@postgres:5432/agent_platform
    depends_on:
      - postgres

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: agent_platform
      POSTGRES_USER: agent
      POSTGRES_PASSWORD: password
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

---

## 一句话总结

**本周重点**: 修复 @提及机制 → 迁移 PostgreSQL → Agent 身份管理 Phase 1

**长期方向**: 混合数据库架构 + 完善的 Agent 管理系统
