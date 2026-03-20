/**
 * GatewayManager - 多 Gateway 编排和管理
 * 
 * 职责:
 * - Gateway 注册/注销
 * - 状态监控（心跳）
 * - 负载均衡
 * - 故障恢复
 */

import { prisma } from '@/lib/prisma';
import { GatewayClient } from './GatewayClient';
import type {
  GatewayConfig,
  GatewayStatus,
  Task,
  AssignmentResult,
  BroadcastResult,
  SelectionCriteria,
  ControlPlaneStateDB,
} from './types';

export class GatewayManager {
  private clients: Map<string, GatewayClient> = new Map();
  private healthCheckTimer?: NodeJS.Timeout;
  private currentIndex: number = 0; // Round Robin 计数器
  private eventHandlers: Map<string, Array<(...args: any[]) => void>> = new Map();

  /**
   * 注册 Gateway
   */
  async registerGateway(config: GatewayConfig): Promise<void> {
    try {
      // 创建 GatewayClient
      const client = new GatewayClient({
        gatewayId: config.id,
        gatewayUrl: config.url,
        gatewayToken: config.token,
      });

      // 尝试连接
      await client.connect();

      // 存储客户端
      this.clients.set(config.id, client);

      // 更新数据库状态
      await this.updateGatewayState(config.id, {
        status: 'online',
        lastHeartbeat: new Date(),
        consecutiveFails: 0,
      });

      // 启动自动心跳
      client.startAutoHeartbeat(30000);

      console.log(`[GatewayManager] Registered gateway: ${config.id}`);
      this.emit('gateway:registered', { gatewayId: config.id });
    } catch (error) {
      console.error(`[GatewayManager] Failed to register gateway ${config.id}: ${error}`);
      throw error;
    }
  }

  /**
   * 注销 Gateway
   */
  async unregisterGateway(gatewayId: string): Promise<void> {
    const client = this.clients.get(gatewayId);
    
    if (client) {
      await client.disconnect();
      this.clients.delete(gatewayId);

      await this.updateGatewayState(gatewayId, {
        status: 'offline',
      });

      console.log(`[GatewayManager] Unregistered gateway: ${gatewayId}`);
      this.emit('gateway:unregistered', { gatewayId });
    }
  }

  /**
   * 获取 Gateway 状态
   */
  async getGatewayStatus(gatewayId: string): Promise<GatewayStatus> {
    const state = await prisma.controlPlaneState.findUnique({
      where: { gatewayId },
    });

    if (!state) {
      throw new Error(`Gateway ${gatewayId} not found`);
    }

    const client = this.clients.get(gatewayId);
    const activeTasks = 0; // TODO: 从任务系统获取
    const totalTasks = 0;

    return {
      id: state.gatewayId,
      status: state.status as any,
      lastHeartbeat: state.lastHeartbeat,
      loadScore: state.loadScore,
      latencyMs: state.latency,
      consecutiveFails: state.consecutiveFails,
      activeTasks,
      totalTasks,
    };
  }

  /**
   * 获取所有 Gateway
   */
  async getAllGateways(): Promise<GatewayStatus[]> {
    const states = await prisma.controlPlaneState.findMany({
      orderBy: { createdAt: 'asc' },
    });

    return Promise.all(
      states.map((state) => this.getGatewayStatus(state.gatewayId))
    );
  }

  /**
   * 分配任务到 Gateway
   */
  async assignTask(task: Task): Promise<AssignmentResult> {
    try {
      // 选择最优 Gateway
      const gatewayId = await this.selectBestGateway();

      // 发送任务
      const client = this.clients.get(gatewayId);
      if (!client) {
        throw new Error(`Gateway ${gatewayId} not available`);
      }

      const result = await client.sendMessage({
        type: 'task',
        action: 'execute',
        taskId: task.id,
        taskType: task.type,
        description: task.description,
        payload: task.payload,
        priority: task.priority,
        timeoutMs: task.timeoutMs,
      });

      if (result.success) {
        return {
          success: true,
          assignedGatewayId: gatewayId,
          taskId: task.id,
          timestamp: new Date(),
        };
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      return {
        success: false,
        assignedGatewayId: '',
        taskId: task.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
      };
    }
  }

  /**
   * 广播任务到所有 Gateway
   */
  async broadcastTask(task: Task): Promise<BroadcastResult> {
    const gateways = await this.getAllGateways();
    const onlineGateways = gateways.filter((g) => g.status === 'online');

    const results: Array<{
      gatewayId: string;
      success: boolean;
      error?: string;
    }> = [];

    let success = 0;
    let failed = 0;

    for (const gateway of onlineGateways) {
      const client = this.clients.get(gateway.id);
      if (!client) continue;

      const result = await client.sendMessage({
        type: 'task',
        action: 'broadcast',
        taskId: task.id,
        taskType: task.type,
        description: task.description,
        payload: task.payload,
      });

      if (result.success) {
        success++;
        results.push({ gatewayId: gateway.id, success: true });
      } else {
        failed++;
        results.push({ gatewayId: gateway.id, success: false, error: result.error });
      }
    }

    return {
      success,
      failed,
      total: onlineGateways.length,
      results,
      timestamp: new Date(),
    };
  }

  /**
   * 选择最优 Gateway
   */
  async selectBestGateway(criteria?: SelectionCriteria): Promise<string> {
    const strategy = criteria?.strategy || 'round-robin';
    const gateways = await this.getAllGateways();
    const available = gateways.filter(
      (g) =>
        g.status === 'online' &&
        (!criteria?.maxLoadScore || g.loadScore <= criteria.maxLoadScore) &&
        (!criteria?.maxLatencyMs || g.latencyMs <= criteria.maxLatencyMs) &&
        (!criteria?.excludeGatewayIds || !criteria.excludeGatewayIds.includes(g.id))
    );

    if (available.length === 0) {
      throw new Error('No available gateways');
    }

    switch (strategy) {
      case 'round-robin':
        return this.selectRoundRobin(available);

      case 'least-loaded':
        return this.selectLeastLoaded(available);

      case 'latency-based':
        return this.selectLowestLatency(available);

      case 'priority':
        return this.selectByPriority(available);

      default:
        return this.selectRoundRobin(available);
    }
  }

  /**
   * 启动健康检查
   */
  startHealthCheck(intervalMs: number = 30000): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(async () => {
      await this.performHealthCheck();
    }, intervalMs);

    console.log(`[GatewayManager] Health check started (${intervalMs}ms)`);
  }

  /**
   * 停止健康检查
   */
  stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  /**
   * 执行健康检查
   */
  private async performHealthCheck(): Promise<void> {
    const gateways = await this.getAllGateways();

    for (const gateway of gateways) {
      const client = this.clients.get(gateway.id);
      if (!client) continue;

      try {
        const result = await client.heartbeat();

        if (result.success) {
          // 更新状态
          await this.updateGatewayState(gateway.id, {
            status: 'online',
            lastHeartbeat: new Date(),
            latency: result.latencyMs,
            consecutiveFails: 0,
            loadScore: this.calculateLoadScore(result.gatewayInfo),
          });
        } else {
          await this.handleHeartbeatFailure(gateway.id);
        }
      } catch (error) {
        console.error(`[GatewayManager] Health check failed for ${gateway.id}: ${error}`);
        await this.handleHeartbeatFailure(gateway.id);
      }
    }
  }

  /**
   * 处理心跳失败
   */
  private async handleHeartbeatFailure(gatewayId: string): Promise<void> {
    const state = await prisma.controlPlaneState.findUnique({
      where: { gatewayId },
    });

    if (!state) return;

    const consecutiveFails = state.consecutiveFails + 1;

    await this.updateGatewayState(gatewayId, {
      consecutiveFails,
      status: consecutiveFails >= 3 ? 'offline' : 'unhealthy',
    });

    if (consecutiveFails >= 3) {
      console.warn(`[GatewayManager] Gateway ${gatewayId} marked as offline`);
      this.emit('gateway:offline', { gatewayId, reason: 'Heartbeat failed 3 times' });

      // 触发故障切换
      await this.handleFailover(gatewayId);
    } else {
      console.warn(`[GatewayManager] Gateway ${gatewayId} unhealthy (${consecutiveFails}/3)`);
      this.emit('gateway:unhealthy', { gatewayId, consecutiveFails });
    }
  }

  /**
   * 处理故障切换
   */
  private async handleFailover(failedGatewayId: string): Promise<void> {
    console.log(`[GatewayManager] Handling failover for ${failedGatewayId}`);
    // TODO: 重新分配该 Gateway 上的任务
    this.emit('gateway:failover', { gatewayId: failedGatewayId });
  }

  /**
   * 计算负载分数
   */
  private calculateLoadScore(gatewayInfo: any): number {
    // TODO: 根据 CPU、内存、活跃任务数计算负载分数
    return 0;
  }

  /**
   * 更新 Gateway 状态
   */
  private async updateGatewayState(
    gatewayId: string,
    state: Partial<ControlPlaneStateDB>
  ): Promise<void> {
    await prisma.controlPlaneState.upsert({
      where: { gatewayId },
      create: {
        gatewayId,
        status: 'online',
        lastHeartbeat: new Date(),
        loadScore: 0,
        latency: 0,
        consecutiveFails: 0,
        ...state,
      },
      update: state,
    });
  }

  /**
   * Round Robin 选择
   */
  private selectRoundRobin(gateways: GatewayStatus[]): string {
    const gateway = gateways[this.currentIndex % gateways.length];
    this.currentIndex = (this.currentIndex + 1) % gateways.length;
    return gateway.id;
  }

  /**
   * 选择负载最低的 Gateway
   */
  private selectLeastLoaded(gateways: GatewayStatus[]): string {
    return gateways.reduce((best, current) =>
      current.loadScore < best.loadScore ? current : best
    ).id;
  }

  /**
   * 选择延迟最低的 Gateway
   */
  private selectLowestLatency(gateways: GatewayStatus[]): string {
    return gateways.reduce((best, current) =>
      current.latencyMs < best.latencyMs ? current : best
    ).id;
  }

  /**
   * 按优先级选择
   */
  private selectByPriority(gateways: GatewayStatus[]): string {
    // TODO: 实现优先级逻辑
    return gateways[0].id;
  }

  /**
   * 事件订阅
   */
  on(event: string, handler: (...args: any[]) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(handler);
  }

  /**
   * 事件取消订阅
   */
  off(event: string, handler: (...args: any[]) => void): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  /**
   * 触发事件
   */
  private emit(event: string, data: any): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach((handler) => handler(data));
    }
  }

  /**
   * 获取所有客户端
   */
  getClients(): Map<string, GatewayClient> {
    return new Map(this.clients);
  }
}
