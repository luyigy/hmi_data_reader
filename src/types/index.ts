export interface Agent {
  id: string;
  name: string;
  type: string;
  location?: string;
  capabilities: string[];
  status: 'online' | 'offline' | 'busy' | 'error';
  lastHeartbeat: string;
  gatewayId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Gateway {
  id: string;
  name: string;
  url?: string;  // Gateway API URL
  token?: string;  // Authentication token
  ip?: string;  // Legacy field
  status: 'online' | 'offline' | 'maintenance';
  resources?: GatewayResources;
  agentCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayResources {
  cpu: number;
  memory: number;
  disk: number;
}

export interface Task {
  id: string;
  name: string;
  description?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  assignedAgents: Agent[];
  result?: Record<string, unknown>;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardStats {
  totalAgents: number;
  onlineAgents: number;
  busyAgents: number;
  offlineAgents: number;
}
