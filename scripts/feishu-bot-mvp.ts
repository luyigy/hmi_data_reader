#!/usr/bin/env ts-node
/**
 * Feishu Bot MVP - 最简 Agent 通信工具
 * 
 * 功能：
 * 1. 监听 Feishu 群聊消息
 * 2. 识别 @提及（@Linux-Agent 或 @HK-vision）
 * 3. 触发本地 Agent 响应
 * 4. 将响应发送回群聊
 * 
 * 部署：
 * - Windows: 在此机器运行
 * - Linux: 在服务器运行相同脚本
 * - 两边监听同一个群聊
 */

import crypto from 'crypto';

// ============ 配置项（从环境变量读取） ============
const CONFIG = {
  // Feishu Bot 配置
  FEISHU_APP_ID: process.env.FEISHU_APP_ID || '',
  FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET || '',
  FEISHU_VERIFICATION_TOKEN: process.env.FEISHU_VERIFICATION_TOKEN || '',
  
  // 群聊 ID
  FEISHU_CHAT_ID: process.env.FEISHU_CHAT_ID || 'oc_5ec3cc43833cfa94539abfbc2a7f8b8a',
  
  // 当前 Agent 配置
  AGENT_NAME: process.env.AGENT_NAME || 'HK-vision', // Linux 上改为 'Linux-Agent'
  AGENT_ID: process.env.AGENT_ID || 'ou_3c3f67f71b6aad10c583c6a0dbe2f264', // 自己的 Feishu user_id
  
  // 服务器端口（接收 Feishu Event Subscription 回调）
  PORT: parseInt(process.env.PORT || '3001', 10),
};

// ============ Feishu API 客户端 ============
class FeishuClient {
  private tenantAccessToken: string | null = null;
  private tokenExpireTime: number = 0;

  // 获取 Tenant Access Token
  async getTenantAccessToken(): Promise<string> {
    if (this.tenantAccessToken && Date.now() < this.tokenExpireTime) {
      return this.tenantAccessToken;
    }

    const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: CONFIG.FEISHU_APP_ID,
        app_secret: CONFIG.FEISHU_APP_SECRET,
      }),
    });

    const data = await response.json();
    if (data.code !== 0) {
      throw new Error(`Failed to get tenant access token: ${data.msg}`);
    }

    this.tenantAccessToken = data.tenant_access_token;
    this.tokenExpireTime = Date.now() + (data.expire - 100) * 1000; // 提前 100 秒刷新
    return this.tenantAccessToken;
  }

  // 发送消息到群聊
  async sendTextMessage(chatId: string, text: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    
    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
      searchParams: { receive_id_type: 'chat_id' },
    });

    const data = await response.json();
    if (data.code !== 0) {
      throw new Error(`Failed to send message: ${data.msg}`);
    }

    console.log(`✅ 消息已发送：${text.substring(0, 50)}...`);
  }

  // 回复消息（带引用）
  async replyMessage(chatId: string, messageId: string, text: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    
    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
        reply_id: messageId,
      }),
      searchParams: { receive_id_type: 'chat_id' },
    });

    const data = await response.json();
    if (data.code !== 0) {
      throw new Error(`Failed to reply message: ${data.msg}`);
    }

    console.log(`✅ 已回复消息：${text.substring(0, 50)}...`);
  }
}

// ============ 消息处理器 ============
class MessageHandler {
  private feishuClient = new FeishuClient();

  // 解析 Feishu 消息事件
  parseMessageEvent(body: any): { messageType: string; content: string; messageId: string; senderId: string; mentions?: string[] } | null {
    try {
      const { header, event } = body;
      
      if (header?.event_type !== 'im.message.receive_v1') {
        return null;
      }

      const message = event.message;
      const messageType = message.message_type;
      const content = JSON.parse(message.content);
      
      // 提取@提及
      const mentions = message.mentions?.map((m: any) => m.id.open_id) || [];

      return {
        messageType,
        content: content.text || content.content || '',
        messageId: message.message_id,
        senderId: message.sender?.id?.open_id || '',
        mentions,
      };
    } catch (error) {
      console.error('解析消息失败:', error);
      return null;
    }
  }

  // 检查消息是否@了自己
  isMentionedToMe(mentions: string[]): boolean {
    return mentions.includes(CONFIG.AGENT_ID);
  }

  // 生成 Agent 响应
  async generateResponse(message: string): Promise<string> {
    const agentName = CONFIG.AGENT_NAME;
    
    // 简单的响应逻辑（后续可以集成 LLM）
    const responses: Record<string, string> = {
      '测试': `👋 ${agentName} 收到测试消息！通信正常！`,
      '你好': `你好！我是 ${agentName}，随时待命！`,
      '状态': `📊 ${agentName} 状态报告：\n- 运行中 ✅\n- 网关：${process.env.GATEWAY_ID || '未配置'}\n- 时间：${new Date().toISOString()}`,
      'ping': `🏓 Pong! 来自 ${agentName}`,
    };

    // 匹配关键词
    for (const [keyword, response] of Object.entries(responses)) {
      if (message.toLowerCase().includes(keyword.toLowerCase())) {
        return response;
      }
    }

    // 默认响应
    return `📨 ${agentName} 收到消息："${message}"\n（当前是 MVP 版本，仅支持关键词回复：测试/你好/状态/ping）`;
  }

  // 处理收到的消息
  async handleMessage(event: ReturnType<typeof this.parseMessageEvent>): Promise<void> {
    if (!event) return;

    console.log(`📨 收到消息：${event.content} (发送者：${event.senderId})`);

    // 检查是否@了自己
    if (event.mentions && this.isMentionedToMe(event.mentions)) {
      console.log(`🎯 消息@了 ${CONFIG.AGENT_NAME}，准备响应...`);
      
      const response = await this.generateResponse(event.content);
      
      // 回复消息（带引用）
      await this.feishuClient.replyMessage(CONFIG.FEISHU_CHAT_ID, event.messageId, response);
    }
  }
}

// ============ HTTP 服务器（接收 Feishu 回调） ============
import { createServer } from 'http';

class FeishuBotServer {
  private handler = new MessageHandler();

  start(): void {
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method Not Allowed');
        return;
      }

      let body = '';
      req.on('data', chunk => { body += chunk; });
      
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body);
          
          // 验证挑战（Feishu 回调验证）
          if (parsed.type === 'url_verification') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ challenge: parsed.challenge }));
            console.log('✅ Feishu 回调验证成功');
            return;
          }

          // 处理消息事件
          const event = this.handler.parseMessageEvent(parsed);
          if (event) {
            await this.handler.handleMessage(event);
          }

          res.writeHead(200);
          res.end('OK');
        } catch (error) {
          console.error('处理请求失败:', error);
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      });
    });

    server.listen(CONFIG.PORT, () => {
      console.log(`🚀 Feishu Bot MVP 启动成功！`);
      console.log(`📍 监听端口：${CONFIG.PORT}`);
      console.log(`🤖 Agent 名称：${CONFIG.AGENT_NAME}`);
      console.log(`💬 群聊 ID: ${CONFIG.FEISHU_CHAT_ID}`);
      console.log(`\n📝 使用说明:`);
      console.log(`1. 在 Feishu 开放平台配置回调 URL: http://<你的 IP>:${CONFIG.PORT}`);
      console.log(`2. 在群聊中@${CONFIG.AGENT_NAME} 测试通信`);
      console.log(`3. 支持关键词：测试/你好/状态/ping`);
    });
  }
}

// ============ 启动 ============
console.log('🔧 检查配置...');
if (!CONFIG.FEISHU_APP_ID || !CONFIG.FEISHU_APP_SECRET) {
  console.error('❌ 错误：缺少 Feishu 配置');
  console.error('请设置环境变量:');
  console.error('  FEISHU_APP_ID=你的 App ID');
  console.error('  FEISHU_APP_SECRET=你的 App Secret');
  console.error('  FEISHU_VERIFICATION_TOKEN=你的 Verification Token');
  console.error('  AGENT_NAME=HK-vision (或 Linux-Agent)');
  console.error('  AGENT_ID=你的 Feishu user_id');
  process.exit(1);
}

console.log('✅ 配置检查通过');
new FeishuBotServer().start();
