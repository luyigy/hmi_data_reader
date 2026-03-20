/**
 * Control Plane - TypeScript 类型定义
 */

// ==================== GatewayClient ====================

export interface GatewayClientConfig {
  gatewayId: string;
  gatewayUrl: string;
  gatewayToken: string;
  timeoutMs?: number;        // 请求超时 (默认 5000ms)
  retryAttempts?: number;    // 重试次数 (默认 3)
  retryDelayMs?: number;     // 重试间隔 (默认 1000ms)
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  timestamp: Date;
}

export interface HeartbeatResult {
  success: boolean;
  latencyMs: number;
  gatewayInfo: GatewayInfo;
  timestamp: Date;
}

export interface GatewayInfo {
  id: string;
  name: string;
  url: string;
  status: 'online' | 'offline' | 'maintenance' | 'unhealthy';
  resources?: {
    cpu?: number;
    memory?: number;
    disk?: number;
  };
  agents?: AgentInfo[];
}

export interface AgentInfo {
  id: string;
  name: string;
  type: string;
  status: 'online' | 'offline' | 'busy';
  capabilities: string[];
}

export interface Message {
  id: string;
  fromGatewayId: string;
  toGatewayId: string;
  type: 'direct' | 'broadcast' | 'request';
  payload: Record<string, unknown>;
  timestamp: Date;
}

// ==================== GatewayManager ====================

export interface GatewayConfig {
  id: string;
  name: string;
  url: string;
  token: string;
  priority?: number;       // 优先级 (默认 0, 越高越优先)
  maxLoad?: number;        // 最大负载 (0-100, 默认 100)
  metadata?: Record<string, unknown>;
}

export interface GatewayStatus {
  id: string;
  status: 'online' | 'offline' | 'maintenance' | 'unhealthy';
  lastHeartbeat: Date;
  loadScore: number;       // 0-100, 越低越好
  latencyMs: number;
  consecutiveFails: number;
  activeTasks: number;
  totalTasks: number;
}

export interface Task {
  id: string;
  type: string;
  description: string;
  payload: Record<string, unknown>;
  priority?: number;       // 1-10, 越高越紧急
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export interface AssignmentResult {
  success: boolean;
  assignedGatewayId: string;
  taskId: string;
  error?: string;
  timestamp: Date;
}

export interface BroadcastResult {
  success: number;         // 成功发送的 Gateway 数量
  failed: number;          // 失败的 Gateway 数量
  total: number;           // 总 Gateway 数量
  results: Array<{
    gatewayId: string;
    success: boolean;
    error?: string;
  }>;
  timestamp: Date;
}

export interface SelectionCriteria {
  strategy?: 'round-robin' | 'least-loaded' | 'latency-based' | 'priority';
  requiredCapabilities?: string[];
  maxLatencyMs?: number;
  maxLoadScore?: number;
  excludeGatewayIds?: string[];
}

// ==================== FeishuCommandRouter ====================

export interface FeishuMessage {
  message_id: string;
  root_id: string;
  parent_id: string;
  create_time: string;
  msg_type: 'text' | 'post' | 'interactive';
  content: string;
  chat_id: string;
  author_id: string;
  mentions?: string[];   // 提及的用户 ID 列表
}

export interface ParsedCommand {
  command: string;       // 命令名称 (如 "execute", "broadcast")
  args: string[];        // 位置参数
  options: Record<string, string | boolean>;  // 选项 (--key=value)
  rawMessage: string;    // 原始消息内容
  chatId: string;
  authorId: string;
  timestamp: Date;
}

export interface RouteResult {
  success: boolean;
  response?: string;
  error?: string;
  executedCommand?: string;
  timestamp: Date;
}

export interface CommandHandler {
  (command: ParsedCommand): Promise<RouteResult>;
}

export interface FeishuCommandRouterConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey?: string;
  pollingIntervalMs?: number;  // 轮询间隔 (默认 5000ms)
  chatId?: string;             // 监听的群聊 ID (可选，不指定则监听所有)
}

// ==================== ControlPlaneState (Database) ====================

export interface ControlPlaneStateDB {
  id: string;
  gatewayId: string;
  status: 'online' | 'offline' | 'unhealthy' | 'maintenance';
  lastHeartbeat: Date;
  loadScore: number;
  latency: number;
  consecutiveFails: number;
  metadata: string | null;  // JSON
  createdAt: Date;
  updatedAt: Date;
}

// ==================== Events ====================

export type ControlPlaneEvent =
  | GatewayOnlineEvent
  | GatewayOfflineEvent
  | GatewayUnhealthyEvent
  | TaskAssignedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | CommandReceivedEvent
  | CommandExecutedEvent;

export interface GatewayOnlineEvent {
  type: 'gateway:online';
  gatewayId: string;
  timestamp: Date;
}

export interface GatewayOfflineEvent {
  type: 'gateway:offline';
  gatewayId: string;
  reason: string;
  timestamp: Date;
}

export interface GatewayUnhealthyEvent {
  type: 'gateway:unhealthy';
  gatewayId: string;
  latencyMs: number;
  loadScore: number;
  timestamp: Date;
}

export interface TaskAssignedEvent {
  type: 'task:assigned';
  taskId: string;
  gatewayId: string;
  timestamp: Date;
}

export interface TaskCompletedEvent {
  type: 'task:completed';
  taskId: string;
  gatewayId: string;
  result: unknown;
  timestamp: Date;
}

export interface TaskFailedEvent {
  type: 'task:failed';
  taskId: string;
  gatewayId: string;
  error: string;
  timestamp: Date;
}

export interface CommandReceivedEvent {
  type: 'command:received';
  command: string;
  chatId: string;
  authorId: string;
  timestamp: Date;
}

export interface CommandExecutedEvent {
  type: 'command:executed';
  command: string;
  success: boolean;
  error?: string;
  timestamp: Date;
}

// ==================== Event Handler ====================

export interface EventHandler {
  (event: ControlPlaneEvent): Promise<void> | void;
}

export interface EventEmitter {
  on(event: string, handler: EventHandler): void;
  off(event: string, handler: EventHandler): void;
  emit(event: ControlPlaneEvent): void;
}
