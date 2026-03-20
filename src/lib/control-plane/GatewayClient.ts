/**
 * GatewayClient - 封装与单个 Gateway 的通信
 * 
 * 职责:
 * - 连接管理（HTTP/WebSocket）
 * - 认证（Token 管理）
 * - 消息发送/接收
 * - 健康检查（心跳）
 */

import type {
  GatewayClientConfig,
  SendResult,
  HeartbeatResult,
  GatewayInfo,
  Message,
} from './types';

export class GatewayClient {
  private config: GatewayClientConfig;
  private connected: boolean = false;
  private messageHandlers: Array<(message: Message) => void> = [];
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectAttempts: number = 0;
  private lastHeartbeat?: Date;

  constructor(config: GatewayClientConfig) {
    this.config = config;
  }

  /**
   * 连接到 Gateway
   * 当前实现使用 HTTP REST API（复用现有端点）
   */
  async connect(): Promise<void> {
    try {
      // 验证连接
      await this.authenticate(this.config.gatewayToken);
      this.connected = true;
      this.reconnectAttempts = 0;
      console.log(`[GatewayClient] Connected to ${this.config.gatewayUrl}`);
    } catch (error) {
      console.error(`[GatewayClient] Failed to connect: ${error}`);
      throw error;
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    this.connected = false;
    
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    console.log(`[GatewayClient] Disconnected from ${this.config.gatewayUrl}`);
  }

  /**
   * 检查连接状态
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * 认证（验证 Token）
   */
  async authenticate(token: string): Promise<boolean> {
    try {
      const response = await this.httpGet('/api/gateways', {
        'Authorization': `Bearer ${token}`,
      });

      if (response.ok) {
        return true;
      } else if (response.status === 401) {
        throw new Error('Invalid token');
      } else {
        throw new Error(`Authentication failed: ${response.status}`);
      }
    } catch (error) {
      console.error(`[GatewayClient] Authentication failed: ${error}`);
      return false;
    }
  }

  /**
   * 发送消息到 Gateway
   */
  async sendMessage(payload: Record<string, unknown>): Promise<SendResult> {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    try {
      const messageUrl = `${this.config.gatewayUrl}/api/gateways/messages/incoming`;
      
      const response = await fetch(messageUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.gatewayToken}`,
        },
        body: JSON.stringify({
          fromGatewayId: 'control-plane',
          message: payload,
          type: 'direct',
        }),
      });

      if (response.ok) {
        const data = await response.json();
        return {
          success: true,
          messageId: data.messageId,
          timestamp: new Date(),
        };
      } else {
        const errorText = await response.text();
        return {
          success: false,
          error: `HTTP ${response.status}: ${errorText}`,
          timestamp: new Date(),
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
      };
    }
  }

  /**
   * 注册消息接收回调
   */
  onMessage(callback: (message: Message) => void): void {
    this.messageHandlers.push(callback);
  }

  /**
   * 发送心跳并获取 Gateway 信息
   */
  async heartbeat(): Promise<HeartbeatResult> {
    const startTime = Date.now();

    try {
      const gatewayInfo = await this.getGatewayInfo();
      const latencyMs = Date.now() - startTime;

      this.lastHeartbeat = new Date();

      return {
        success: true,
        latencyMs,
        gatewayInfo,
        timestamp: new Date(),
      };
    } catch (error) {
      return {
        success: false,
        latencyMs: Date.now() - startTime,
        gatewayInfo: {
          id: this.config.gatewayId,
          name: 'Unknown',
          url: this.config.gatewayUrl,
          status: 'offline',
        },
        timestamp: new Date(),
      };
    }
  }

  /**
   * 获取 Gateway 信息
   */
  async getGatewayInfo(): Promise<GatewayInfo> {
    try {
      // 获取 Gateway 详情
      const response = await this.httpGet(`/api/gateways`, {
        'Authorization': `Bearer ${this.config.gatewayToken}`,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch gateway info: ${response.status}`);
      }

      const gateways = await response.json();
      const gateway = gateways.find((g: any) => g.id === this.config.gatewayId);

      if (!gateway) {
        throw new Error('Gateway not found');
      }

      return {
        id: gateway.id,
        name: gateway.name,
        url: gateway.url || this.config.gatewayUrl,
        status: gateway.status || 'online',
        resources: gateway.resources,
        agents: gateway.agents?.map((agent: any) => ({
          id: agent.id,
          name: agent.name,
          type: agent.type,
          status: agent.status,
          capabilities: agent.capabilities ? JSON.parse(agent.capabilities) : [],
        })),
      };
    } catch (error) {
      console.error(`[GatewayClient] Failed to get gateway info: ${error}`);
      throw error;
    }
  }

  /**
   * 启动自动心跳
   */
  startAutoHeartbeat(intervalMs: number = 30000): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(async () => {
      try {
        const result = await this.heartbeat();
        if (!result.success) {
          console.warn(`[GatewayClient] Heartbeat failed: ${result.latencyMs}ms`);
        }
      } catch (error) {
        console.error(`[GatewayClient] Heartbeat error: ${error}`);
      }
    }, intervalMs);

    console.log(`[GatewayClient] Auto heartbeat started (${intervalMs}ms)`);
  }

  /**
   * 通用 HTTP GET 请求
   */
  private async httpGet(path: string, headers: Record<string, string> = {}): Promise<Response> {
    const url = `${this.config.gatewayUrl}${path}`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs || 5000);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * 通用 HTTP POST 请求
   */
  private async httpPost(
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    const url = `${this.config.gatewayUrl}${path}`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs || 5000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * 获取配置信息
   */
  getConfig(): GatewayClientConfig {
    return { ...this.config };
  }

  /**
   * 获取最后心跳时间
   */
  getLastHeartbeat(): Date | undefined {
    return this.lastHeartbeat;
  }
}
