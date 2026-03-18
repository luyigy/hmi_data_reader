# Feishu Bot MVP - 最简 Agent 通信工具

**创建时间**: 2026-03-18 22:55  
**用途**: Windows ↔ Linux Agent 实时通信（通过 Feishu 群聊）

---

## 🎯 功能

- ✅ 监听 Feishu 群聊消息
- ✅ 识别@提及（@Linux-Agent 或 @HK-vision）
- ✅ 自动响应被@的消息
- ✅ 消息显示在群聊中（用户可见）

---

## 📋 部署步骤

### 步骤 1: Feishu 开放平台配置

1. 访问 https://open.feishu.cn/
2. 创建企业自建应用
3. 获取以下信息：
   - **App ID**
   - **App Secret**
   - **Verification Token**

4. 配置事件订阅：
   - 启用事件订阅
   - 配置回调 URL：`http://<你的 IP>:3001`
   - 订阅事件：`接收消息 v1` (im.message.receive_v1)

5. 配置机器人：
   - 启用机器人
   - 添加到群聊：`oc_5ec3cc43833cfa94539abfbc2a7f8b8a`

---

### 步骤 2: Windows 部署（HK-vision）

```powershell
# 1. 进入项目目录
cd E:\projects\agent-platform-v2

# 2. 设置环境变量
$env:FEISHU_APP_ID="你的 App ID"
$env:FEISHU_APP_SECRET="你的 App Secret"
$env:FEISHU_VERIFICATION_TOKEN="你的 Verification Token"
$env:AGENT_NAME="HK-vision"
$env:AGENT_ID="ou_3c3f67f71b6aad10c583c6a0dbe2f264"
$env:FEISHU_CHAT_ID="oc_5ec3cc43833cfa94539abfbc2a7f8b8a"
$env:PORT="3001"

# 3. 运行脚本
npx ts-node scripts/feishu-bot-mvp.ts
```

---

### 步骤 3: Linux 部署（Linux-Agent）

```bash
# 1. 拉取最新代码
cd /path/to/agent-platform-v2
git pull origin master

# 2. 设置环境变量
export FEISHU_APP_ID="你的 App ID"
export FEISHU_APP_SECRET="你的 App Secret"
export FEISHU_VERIFICATION_TOKEN="你的 Verification Token"
export AGENT_NAME="Linux-Agent"
export AGENT_ID="ou_xxx"  # Linux-Agent 的 Feishu user_id
export FEISHU_CHAT_ID="oc_5ec3cc43833cfa94539abfbc2a7f8b8a"
export PORT="3001"

# 3. 运行脚本
npx ts-node scripts/feishu-bot-mvp.ts
```

---

### 步骤 4: 测试通信

**在 Feishu 群聊中发送**:

```
@HK-vision 测试
@Linux-Agent 你好
@HK-vision 状态
@Linux-Agent ping
```

**预期响应**:

```
@HK-vision 测试
→ 👋 HK-vision 收到测试消息！通信正常！

@Linux-Agent 你好
→ 你好！我是 Linux-Agent，随时待命！
```

---

## 🔧 支持的关键词

| 关键词 | 响应示例 |
|--------|----------|
| 测试 | 👋 XXX 收到测试消息！通信正常！ |
| 你好 | 你好！我是 XXX，随时待命！ |
| 状态 | 📊 XXX 状态报告：运行中 ✅ ... |
| ping | 🏓 Pong! 来自 XXX |

---

## 🚨 常见问题

### Q1: 回调 URL 配置失败
**解决**: 确保服务器可以公网访问，或使用内网穿透工具

### Q2: 消息不响应
**解决**: 
1. 检查是否正确@了机器人
2. 检查日志输出
3. 确认 AGENT_ID 配置正确

### Q3: 两边 Agent 都响应同一条消息
**解决**: 检查各自的 AGENT_ID 配置，确保不重复

---

## 📝 下一步扩展

当前是 MVP 版本，后续可以：

1. **集成 LLM** - 生成更智能的响应
2. **任务执行** - @Agent 执行具体任务
3. **上下文记忆** - 记住对话历史
4. **多群聊支持** - 监听多个群聊

---

## 📚 相关文档

- 完整方案：`Z:\03-项目\Agent 通信系统\002_2026-03-18_Agent 实时通信整合方案.md`
- Agent Platform v2: `E:\projects\agent-platform-v2\STATUS.md`

---

**最后更新**: 2026-03-18 22:55  
**状态**: ✅ MVP 完成，待部署测试
