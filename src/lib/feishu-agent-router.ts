/**
 * FeishuAgentRouter - 飞书群聊 Agent 通信路由
 * 
 * 职责:
 * - 发送消息到 Feishu 群聊
 * - 解析群聊中的 Agent@提及消息
 * - 支持 Agent 响应生成
 * 
 * 使用场景:
 * - Agent Platform v2 与 Linux Gateway 之间的通信（替代直接 API 通信）
 * - Agent 间通过飞书群聊进行消息传递
 * - 支持@提及触发 Agent 响应
 * 
 * 注意:
 * - 实际消息发送需要通过 OpenClaw message 工具或 Feishu API
 * - 本模块提供框架，具体实现需根据环境调整
 */

export interface FeishuAgentRouterConfig {
  /** 监听的群聊 ID */
  chatId: string;
  /** 机器人名称（用于识别@提及） */
  botName: string;
  /** 轮询间隔（毫秒），默认 5000ms */
  pollingIntervalMs?: number;
  /** 消息处理回调 */
  onMessage?: (message: FeishuAgentMessage) => Promise<void>;
}

export interface FeishuAgentMessage {
  /** 消息 ID */
  messageId: string;
  /** 发送者 ID */
  authorId: string;
  /** 消息内容 */
  content: string;
  /** 群聊 ID */
  chatId: string;
  /** 时间戳 */
  timestamp: Date;
  /** 是否提及机器人 */
  isMention: boolean;
  /** 提及的 Agent 名称（如果有） */
  mentionedAgent?: string;
  /** 原始消息数据 */
  raw?: any;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  timestamp: Date;
}

export class FeishuAgentRouter {
  private config: FeishuAgentRouterConfig;
  private pollingTimer?: NodeJS.Timeout;
  private lastMessageId?: string;
  private isRunning: boolean = false;

  constructor(config: FeishuAgentRouterConfig) {
    this.config = config;
  }

  /**
   * 发送消息到 Feishu 群聊
   * 
   * 注意：实际实现需要根据环境选择以下方式之一：
   * 1. OpenClaw message 工具（如果在 OpenClaw 环境中）
   * 2. Feishu API 直接调用（需要 app access token）
   * 3. Feishu Webhook（简单场景）
   */
  async sendMessage(content: string, options?: {
    /** 回复的消息 ID（可选） */
    replyTo?: string;
    /** 是否静默发送（不通知） */
    silent?: boolean;
  }): Promise<SendResult> {
    try {
      console.log(`[FeishuAgentRouter] Sending message to ${this.config.chatId}: ${content.substring(0, 50)}...`);

      // TODO: 实现实际的 Feishu 消息发送
      // 选项 1: OpenClaw message 工具
      // const result = await message.send({ target: this.config.chatId, message: content, channel: 'feishu' });
      
      // 选项 2: Feishu API
      // const result = await this.sendViaFeishuApi(content, options);
      
      // 当前：模拟实现（用于测试）
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      console.log(`[FeishuAgentRouter] Message sent (simulated): ${messageId}`);

      return {
        success: true,
        messageId,
        timestamp: new Date(),
      };
    } catch (error) {
      console.error(`[FeishuAgentRouter] Failed to send message: ${error}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
      };
    }
  }

  /**
   * 解析飞书消息，提取@提及
   */
  parseMessage(content: string, rawMessage?: any): FeishuAgentMessage {
    const botMentionPattern = new RegExp(`@(${this.config.botName}|Control Plane|Agent Platform)`, 'i');
    const agentMentionPattern = /@(\w+(?:-\w+)*)/g;
    
    const isMention = botMentionPattern.test(content);
    const mentions = content.match(agentMentionPattern) || [];
    
    // 提取提及的 Agent 名称（排除机器人自己）
    const mentionedAgents = mentions
      .map(m => m.replace('@', ''))
      .filter(name => !name.includes(this.config.botName) && !name.includes('Control Plane') && !name.includes('Agent Platform'));

    return {
      messageId: rawMessage?.message_id || `msg_${Date.now()}`,
      authorId: rawMessage?.author_id || 'unknown',
      content: content.replace(botMentionPattern, '').trim(),
      chatId: this.config.chatId,
      timestamp: new Date(),
      isMention,
      mentionedAgent: mentionedAgents.length > 0 ? mentionedAgents[0] : undefined,
      raw: rawMessage,
    };
  }

  /**
   * 处理接收到的消息
   */
  async handleMessage(rawMessage: any): Promise<void> {
    const content = rawMessage?.content || rawMessage?.text || '';
    const parsedMessage = this.parseMessage(content, rawMessage);

    console.log(`[FeishuAgentRouter] Received message:`, {
      messageId: parsedMessage.messageId,
      authorId: parsedMessage.authorId,
      isMention: parsedMessage.isMention,
      mentionedAgent: parsedMessage.mentionedAgent,
      content: parsedMessage.content.substring(0, 100),
    });

    // 如果不是@提及，忽略
    if (!parsedMessage.isMention) {
      return;
    }

    // 调用消息处理回调
    if (this.config.onMessage) {
      try {
        await this.config.onMessage(parsedMessage);
      } catch (error) {
        console.error(`[FeishuAgentRouter] Message handler error: ${error}`);
      }
    }
  }

  /**
   * 启动消息监听（轮询模式）
   */
  startListening(): void {
    if (this.isRunning) {
      console.warn('[FeishuAgentRouter] Already running');
      return;
    }

    this.isRunning = true;
    const interval = this.config.pollingIntervalMs || 5000;

    console.log(`[FeishuAgentRouter] Started listening on ${this.config.chatId} (interval: ${interval}ms)`);

    // 注意：实际的轮询需要 Feishu API 支持
    // 这里提供框架，实际使用时需要集成 Feishu 消息接收 API
    // 或者使用 Feishu 事件订阅（Event Subscription）

    // 模拟轮询逻辑
    this.pollingTimer = setInterval(async () => {
      try {
        await this.pollMessages();
      } catch (error) {
        console.error(`[FeishuAgentRouter] Poll error: ${error}`);
      }
    }, interval);
  }

  /**
   * 轮询消息（需要 Feishu API 支持）
   */
  private async pollMessages(): Promise<void> {
    // TODO: 实现 Feishu 消息轮询
    // 这需要使用 Feishu 开放平台的消息接收 API
    // 或者使用事件订阅模式（推荐）
    
    // 示例：使用 Feishu 群聊消息列表 API
    // const messages = await feishu.im.v1.messages.list({ chat_id: this.config.chatId });
    
    console.log('[FeishuAgentRouter] Polling messages (placeholder)');
  }

  /**
   * 停止消息监听
   */
  stopListening(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    this.isRunning = false;
    console.log('[FeishuAgentRouter] Stopped listening');
  }

  /**
   * 检查是否正在运行
   */
  isListening(): boolean {
    return this.isRunning;
  }

  /**
   * 发送 Agent 响应
   */
  async sendAgentResponse(agentName: string, response: string, options?: {
    replyTo?: string;
    format?: 'text' | 'markdown' | 'interactive';
  }): Promise<SendResult> {
    const formattedResponse = this.formatResponse(agentName, response, options?.format || 'text');
    return this.sendMessage(formattedResponse, { replyTo: options?.replyTo });
  }

  /**
   * 格式化响应消息
   */
  private formatResponse(agentName: string, response: string, format: 'text' | 'markdown' | 'interactive'): string {
    switch (format) {
      case 'markdown':
        return `**${agentName}**:\n${response}`;
      case 'interactive':
        // 飞书交互式消息需要特殊格式
        // 这里简化为文本
        return `[${agentName}]: ${response}`;
      case 'text':
      default:
        return `[${agentName}]: ${response}`;
    }
  }

  /**
   * 获取配置信息
   */
  getConfig(): FeishuAgentRouterConfig {
    return { ...this.config };
  }
}

/**
 * 创建 FeishuAgentRouter 实例的辅助函数
 */
export function createFeishuAgentRouter(config: FeishuAgentRouterConfig): FeishuAgentRouter {
  return new FeishuAgentRouter(config);
}
