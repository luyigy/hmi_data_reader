# Feishu 通信层测试指南

**创建日期**: 2026-03-26  
**测试目标**: 验证 Agent Platform v2 的 Feishu 群聊通信层  
**测试群聊**: `oc_5ec3cc43833cfa94539abfbc2a7f8b8a` (Agent 通信专用群)

---

## 📋 测试概述

由于 Linux Gateway (192.168.1.4:18789) 无法连接，采用 Feishu 群聊作为 Agent 间通信通道。

**测试范围**:
- ✅ FeishuAgentRouter 模块功能
- ✅ FeishuCommandRouter 集成
- ✅ @提及消息解析
- ✅ Agent 响应生成
- ⏳ 实际 Feishu 消息发送（需要 Feishu Bot 权限）

---

## 🔧 实现文件

### 核心模块

| 文件 | 路径 | 说明 |
|------|------|------|
| **FeishuAgentRouter** | `src/lib/feishu-agent-router.ts` | Feishu 消息路由核心模块 |
| **FeishuCommandRouter** | `src/lib/control-plane/FeishuCommandRouter.ts` | 已更新，集成 FeishuAgentRouter |
| **测试脚本 (TS)** | `tests/test-feishu-communication.ts` | TypeScript 单元测试 |
| **测试脚本 (PS)** | `tests/test-feishu-communication.ps1` | PowerShell 集成测试 |

---

## 🧪 测试步骤

### 步骤 1: 单元测试 (TypeScript)

```bash
cd E:\projects\agent-platform-v2

# 运行 TypeScript 测试
npx ts-node tests/test-feishu-communication.ts
```

**预期输出**:
```
🧪 Feishu 通信测试开始

✅ 测试 1: 创建 FeishuAgentRouter
   配置：{ chatId: 'oc_5ec3cc43833cfa94539abfbc2a7f8b8a', botName: 'Control Plane' }

✅ 测试 2: 消息解析（@提及识别）
   ✅ 包含@Control Plane 提及
   ✅ 包含@Agent 提及
   ✅ 不包含提及
   ✅ 包含@Agent Platform 提及

✅ 测试 3: 发送消息（模拟）
   发送：🧪 Feishu 通信测试消息
   结果：✅ 成功 msg_xxxxx

✅ 测试 4: Agent 响应生成
   Linux-Agent: 任务执行完成
   结果：✅ 成功 msg_xxxxx

✅ 测试 5: 消息处理回调
   收到消息：@Control Plane 测试消息 1
   提及：是

✅ 测试 6: 监听器启动/停止
   监听状态：运行中
   监听状态：已停止

🎉 所有测试完成！
```

### 步骤 2: 集成测试 (PowerShell)

```powershell
cd E:\projects\agent-platform-v2
.\tests\test-feishu-communication.ps1
```

**预期输出**:
```
🧪 Feishu 通信测试开始

✅ 测试 1: 发送测试消息到 Feishu 群聊
   群聊 ID: oc_5ec3cc43833cfa94539abfbc2a7f8b8a
   消息内容：🧪 Feishu 通信测试 - 2026-03-26 11:45:00

✅ 测试 2: 消息格式验证
   ✅ 包含@Control Plane 提及
   ✅ 包含@Agent 提及
   ✅ 不包含提及
   ✅ 包含@Agent Platform 提及

✅ 测试 3: Agent 响应格式
   [Linux-Agent]: ✅ 任务执行完成
   [Codex-Agent]: 📝 代码分析完成
   [Claude-Agent]: 💬 文本处理完成

✅ 测试 4: 实际发送测试
   注意：实际发送需要 OpenClaw 环境支持

🎉 测试完成！
```

### 步骤 3: 实际 Feishu 消息发送

**前提条件**:
- ✅ OpenClaw 环境已配置 Feishu 插件
- ✅ Feishu Bot 已添加到目标群聊
- ✅ Bot 具有发送消息权限

**发送测试消息**:

在 OpenClaw 环境中执行：
```javascript
// 使用 OpenClaw message 工具
message send --target 'oc_5ec3cc43833cfa94539abfbc2a7f8b8a' --channel feishu --message '🧪 Feishu 通信测试'
```

**或在代码中使用**:
```typescript
import { FeishuAgentRouter } from './src/lib/feishu-agent-router';

const router = new FeishuAgentRouter({
  chatId: 'oc_5ec3cc43833cfa94539abfbc2a7f8b8a',
  botName: 'Control Plane',
});

// 发送测试消息
const result = await router.sendMessage('🧪 Feishu 通信测试 - 来自 Agent Platform v2');
console.log(result);
```

### 步骤 4: 验证 Linux-Agent 响应

1. 在 Feishu 群聊中发送测试消息（包含 `@Linux-Agent`）
2. 等待 Linux-Agent 响应
3. 验证响应格式符合预期

**预期响应**:
```
[Linux-Agent]: 收到测试消息，通信正常 ✅
```

---

## 📊 测试用例

### 用例 1: @提及解析

| 输入消息 | 预期 isMention | 预期 mentionedAgent |
|----------|---------------|---------------------|
| `@Control Plane 执行任务` | true | undefined |
| `@Control Plane @Linux-Agent 执行任务` | true | Linux-Agent |
| `普通消息` | false | undefined |
| `@Agent Platform 状态查询` | true | undefined |

### 用例 2: 命令解析

| 输入消息 | 预期命令 | 预期参数 |
|----------|---------|---------|
| `@Control Plane execute --gateway=linux "任务"` | execute | gateway=linux, args=["任务"] |
| `@Control Plane status` | status | - |
| `@Control Plane broadcast "消息"` | broadcast | args=["消息"] |
| `@Control Plane help` | help | - |

### 用例 3: Agent 响应格式

| Agent | 响应内容 | 预期格式 |
|-------|---------|---------|
| Linux-Agent | 任务执行完成 | `[Linux-Agent]: ✅ 任务执行完成` |
| Codex-Agent | 代码分析完成 | `[Codex-Agent]: 📝 代码分析完成` |
| Claude-Agent | 文本处理完成 | `[Claude-Agent]: 💬 文本处理完成` |

---

## 🔍 故障排查

### 问题 1: 消息发送失败

**症状**: `sendMessage` 返回 `success: false`

**可能原因**:
- Feishu Bot 未添加到群聊
- Bot 权限不足
- 群聊 ID 错误

**解决方案**:
1. 确认群聊 ID 正确 (`oc_5ec3cc43833cfa94539abfbc2a7f8b8a`)
2. 检查 Feishu Bot 配置
3. 验证 Bot 在群聊中

### 问题 2: @提及未识别

**症状**: `isMention` 始终为 `false`

**可能原因**:
- 消息格式不正确
- 机器人名称配置错误

**解决方案**:
1. 检查 `botName` 配置
2. 确认消息包含 `@Control Plane` 或 `@Agent Platform`
3. 查看 `parseMessage` 方法的正则表达式

### 问题 3: 监听器未启动

**症状**: 收不到消息

**可能原因**:
- `startListening()` 未调用
- Feishu API 轮询未实现

**解决方案**:
1. 确认调用 `router.startListening()`
2. 实现 Feishu 消息轮询或使用事件订阅
3. 检查 Feishu 开放平台配置

---

## 📝 下一步

### 立即可执行

1. ✅ 运行单元测试验证模块功能
2. ✅ 验证@提及解析逻辑
3. ⏳ 在 OpenClaw 环境中发送实际测试消息
4. ⏳ 等待 Linux-Agent 响应

### 待完成

1. 实现 Feishu 消息轮询（需要 Feishu API）
2. 集成 Feishu 事件订阅（推荐）
3. 添加消息加密（可选）
4. 实现消息历史查询

---

## 🔗 相关文档

- [FeishuAgentRouter 源码](../src/lib/feishu-agent-router.ts)
- [FeishuCommandRouter 源码](../src/lib/control-plane/FeishuCommandRouter.ts)
- [Control Plane 架构](../docs/CONTROL_PLANE_ARCHITECTURE.md)
- [阶段 3 计划](../plans/002_2026-03-20_阶段 3_控制平面增强.md)

---

**测试状态**: 🟡 部分完成（单元测试通过，实际发送待验证）  
**最后更新**: 2026-03-26 11:45
