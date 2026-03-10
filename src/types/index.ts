export interface Agent {
  id: string;
  name: string;
  type: string;
  location?: string;
  capabilities: string[];
  status: 'online' | 'offline' | 'busy' | 'error';
  lastHeartbeat: string;
  nodeId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Node {
  id: string;
  name: string;
  ip?: string;
  status: 'online' | 'offline' | 'maintenance';
  resources?: NodeResources;
  agentCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface NodeResources {
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
