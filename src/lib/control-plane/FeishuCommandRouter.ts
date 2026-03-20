/**
 * FeishuCommandRouter - 飞书命令解析和路由
 * 
 * 职责:
 * - 解析飞书消息中的命令
 * - 路由命令到合适的 Gateway
 * - 返回执行结果到飞书
 */

import { GatewayManager } from './GatewayManager';
import type {
  FeishuMessage,
  ParsedCommand,
  RouteResult,
  CommandHandler,
  FeishuCommandRouterConfig,
} from './types';

export class FeishuCommandRouter {
  private config: FeishuCommandRouterConfig;
  private gatewayManager: GatewayManager;
  private commandHandlers: Map<string, CommandHandler> = new Map();
  private pollingTimer?: NodeJS.Timeout;
  private lastMessageId?: string;

  constructor(config: FeishuCommandRouterConfig, gatewayManager: GatewayManager) {
    this.config = config;
    this.gatewayManager = gatewayManager;
    this.registerBuiltInCommands();
  }

  /**
   * 注册内置命令
   */
  private registerBuiltInCommands(): void {
    // execute 命令
    this.registerHandler('execute', async (command) => {
      const taskDescription = command.args.join(' ') || command.options['task'];
      
      if (!taskDescription) {
        return {
          success: false,
          error: 'Missing task description',
          timestamp: new Date(),
        };
      }

      const gatewayId = command.options['gateway'] as string;
      
      // 创建任务
      const task = {
        id: `task-${Date.now()}`,
        type: 'custom',
        description: taskDescription,
        payload: { command: command.rawMessage },
        priority: command.options['priority'] ? Number(command.options['priority']) : 5,
      };

      // 分配任务
      const result = await this.gatewayManager.assignTask(task);

      if (result.success) {
        return {
          success: true,
          response: `✅ 任务已分配到 Gateway: ${result.assignedGatewayId}\n📝 ${taskDescription}`,
          executedCommand: 'execute',
          timestamp: new Date(),
        };
      } else {
        return {
          success: false,
          error: result.error,
          executedCommand: 'execute',
          timestamp: new Date(),
        };
      }
    });

    // broadcast 命令
    this.registerHandler('broadcast', async (command) => {
      const message = command.args.join(' ');
      
      if (!message) {
        return {
          success: false,
          error: 'Missing broadcast message',
          timestamp: new Date(),
        };
      }

      const task = {
        id: `broadcast-${Date.now()}`,
        type: 'broadcast',
        description: message,
        payload: { command: command.rawMessage },
      };

      const result = await this.gatewayManager.broadcastTask(task);

      return {
        success: true,
        response: `📢 广播完成\n✅ 成功：${result.success}\n❌ 失败：${result.failed}\n📊 总计：${result.total}`,
        executedCommand: 'broadcast',
        timestamp: new Date(),
      };
    });

    // status 命令
    this.registerHandler('status', async () => {
      const gateways = await this.gatewayManager.getAllGateways();

      const statusText = gateways
        .map((g) => {
          const statusEmoji = g.status === 'online' ? '🟢' : g.status === 'offline' ? '🔴' : '🟡';
          return `${statusEmoji} **${g.id}**: ${g.status} (负载：${g.loadScore}%, 延迟：${g.latencyMs}ms)`;
        })
        .join('\n');

      return {
        success: true,
        response: `📊 Gateway 状态:\n${statusText}`,
        executedCommand: 'status',
        timestamp: new Date(),
      };
    });

    // assign 命令
    this.registerHandler('assign', async (command) => {
      // 解析 @Agent 提及
      const agentMention = command.args.find((arg) => arg.startsWith('@'));
      const taskDescription = command.args.filter((arg) => !arg.startsWith('@')).join(' ');

      if (!taskDescription) {
        return {
          success: false,
          error: 'Missing task description',
          timestamp: new Date(),
        };
      }

      const task = {
        id: `assign-${Date.now()}`,
        type: 'agent-task',
        description: taskDescription,
        payload: { 
          command: command.rawMessage,
          agentMention,
        },
      };

      const result = await this.gatewayManager.assignTask(task);

      if (result.success) {
        return {
          success: true,
          response: `✅ 任务已分配\n🤖 ${agentMention || 'Agent'}\n📝 ${taskDescription}`,
          executedCommand: 'assign',
          timestamp: new Date(),
        };
      } else {
        return {
          success: false,
          error: result.error,
          executedCommand: 'assign',
          timestamp: new Date(),
        };
      }
    });

    // list 命令
    this.registerHandler('list', async () => {
      const gateways = await this.gatewayManager.getAllGateways();

      const listText = gateways
        .map((g, i) => `${i + 1}. **${g.id}** - ${g.name || 'Unnamed'} (${g.status})`)
        .join('\n');

      return {
        success: true,
        response: `📋 Gateway 列表:\n${listText || '暂无 Gateway'}`,
        executedCommand: 'list',
        timestamp: new Date(),
      };
    });

    // health 命令
    this.registerHandler('health', async () => {
      const gateways = await this.gatewayManager.getAllGateways();
      const onlineCount = gateways.filter((g) => g.status === 'online').length;
      const unhealthyCount = gateways.filter((g) => g.status === 'unhealthy').length;
      const offlineCount = gateways.filter((g) => g.status === 'offline').length;

      return {
        success: true,
        response: `💚 健康检查\n🟢 在线：${onlineCount}\n🟡 异常：${unhealthyCount}\n🔴 离线：${offlineCount}\n📊 总计：${gateways.length}`,
        executedCommand: 'health',
        timestamp: new Date(),
      };
    });

    // help 命令
    this.registerHandler('help', async () => {
      return {
        success: true,
        response: `📖 **可用命令**:
- \`execute --gateway=ID "任务描述"\` - 执行任务到指定 Gateway
- \`broadcast "消息"\` - 广播到所有 Gateway
- \`status\` - 查询 Gateway 状态
- \`assign @Agent "任务"\` - 分配任务给 Agent
- \`list\` - 列出所有 Gateway
- \`health\` - 健康检查
- \`help\` - 显示帮助`,
        executedCommand: 'help',
        timestamp: new Date(),
      };
    });
  }

  /**
   * 注册命令处理器
   */
  registerHandler(command: string, handler: CommandHandler): void {
    this.commandHandlers.set(command, handler);
  }

  /**
   * 解析飞书消息
   */
  async parseCommand(message: FeishuMessage): Promise<ParsedCommand | null> {
    const content = message.content.trim();

    // 检查是否提及机器人
    if (!content.includes('@Agent Platform') && !content.includes('@Control Plane')) {
      return null;
    }

    // 提取命令部分
    const commandMatch = content.match(/@(?:Agent Platform|Control Plane)\s+(\w+)(?:\s+(.*))?/s);
    
    if (!commandMatch) {
      return null;
    }

    const [, commandName, rawArgs] = commandMatch;
    
    // 解析参数和选项
    const args: string[] = [];
    const options: Record<string, string | boolean> = {};

    if (rawArgs) {
      // 解析 --key=value 格式的选项
      const optionRegex = /--(\w+)(?:=(\S+))?/g;
      let match;
      let remaining = rawArgs;

      while ((match = optionRegex.exec(rawArgs)) !== null) {
        const [, key, value] = match;
        options[key] = value || true;
        remaining = remaining.replace(match[0], '').trim();
      }

      // 剩余部分作为位置参数
      if (remaining) {
        // 处理引号内的内容
        const quoteRegex = /"([^"]+)"|'([^']+)'|\S+/g;
        let argMatch;
        while ((argMatch = quoteRegex.exec(remaining)) !== null) {
          const arg = argMatch[1] || argMatch[2] || argMatch[0];
          args.push(arg);
        }
      }
    }

    return {
      command: commandName.toLowerCase(),
      args,
      options,
      rawMessage: content,
      chatId: message.chat_id,
      authorId: message.author_id,
      timestamp: new Date(),
    };
  }

  /**
   * 路由命令
   */
  async routeCommand(command: ParsedCommand): Promise<RouteResult> {
    const handler = this.commandHandlers.get(command.command);

    if (!handler) {
      return {
        success: false,
        error: `Unknown command: ${command.command}. Use \`help\` for available commands.`,
        timestamp: new Date(),
      };
    }

    try {
      const result = await handler(command);
      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Command execution failed',
        timestamp: new Date(),
      };
    }
  }

  /**
   * 处理飞书消息
   */
  async handleMessage(message: FeishuMessage): Promise<void> {
    const command = await this.parseCommand(message);

    if (!command) {
      return; // 不是命令消息，忽略
    }

    console.log(`[FeishuCommandRouter] Received command: ${command.command}`);

    const result = await this.routeCommand(command);

    // TODO: 发送响应回飞书
    await this.sendResponse(message.chat_id, result.response || result.error || '');
  }

  /**
   * 发送响应到飞书
   */
  private async sendResponse(chatId: string, content: string): Promise<void> {
    // TODO: 实现飞书消息发送
    // 可以使用飞书 Webhook 或 Bot API
    console.log(`[FeishuCommandRouter] Sending response to ${chatId}: ${content}`);
  }

  /**
   * 启动监听器
   */
  startListener(): void {
    console.log('[FeishuCommandRouter] Listener started (polling mode)');
    
    // TODO: 实现飞书消息轮询
    // 这需要飞书开放平台的 API 支持
  }

  /**
   * 停止监听器
   */
  stopListener(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    console.log('[FeishuCommandRouter] Listener stopped');
  }

  /**
   * 获取注册的命令列表
   */
  getRegisteredCommands(): string[] {
    return Array.from(this.commandHandlers.keys());
  }
}
