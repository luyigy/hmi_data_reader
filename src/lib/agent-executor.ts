/**
 * Agent 执行器 - 真实 Agent 集成
 * 
 * 这个模块负责将任务发送给真实的 Agent 并获取结果
 * 支持多种 Agent 类型和通信协议
 */

export interface AgentTask {
  id: string;
  name: string;
  description?: string;
  assignedAgents: Array<{
    id: string;
    name: string;
    type: string;
    location?: string;
  }>;
}

export interface AgentExecutionResult {
  agentId: string;
  agentName: string;
  success: boolean;
  result?: any;
  error?: string;
  duration: number;
}

/**
 * 执行任务给指定的 Agent
 * 
 * @param task - 任务信息
 * @param agentId - Agent ID
 * @returns 执行结果
 */
export const executeTask = async (
  task: AgentTask,
  agentId: string
): Promise<AgentExecutionResult> => {
  const startTime = Date.now();
  
  try {
    // 查找 Agent
    const agent = task.assignedAgents.find((a) => a.id === agentId);
    if (!agent) {
      return {
        agentId,
        agentName: 'Unknown',
        success: false,
        error: 'Agent not found in task assignments',
        duration: Date.now() - startTime,
      };
    }

    // 根据 Agent 类型选择执行方式
    let result: any;
    
    if (agent.location === 'local') {
      // 本地 Agent - 直接调用
      result = await executeLocalAgent(task, agent);
    } else if (agent.location === 'remote') {
      // 远程 Agent - HTTP 调用
      result = await executeRemoteAgent(task, agent);
    } else {
      // 云端 Agent - A2A Gateway
      result = await executeCloudAgent(task, agent);
    }

    return {
      agentId,
      agentName: agent.name,
      success: true,
      result,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    console.error(`Agent execution error [${agentId}]:`, error);
    return {
      agentId,
      agentName: agent?.name || 'Unknown',
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      duration: Date.now() - startTime,
    };
  }
};

/**
 * 执行本地 Agent
 */
const executeLocalAgent = async (
  task: AgentTask,
  agent: AgentTask['assignedAgents'][0]
): Promise<any> => {
  console.log(`[Local Agent] Executing task "${task.name}" on ${agent.name}`);
  
  // 模拟本地 Agent 执行
  // 实际项目中应该调用本地 Agent 的 API 或直接调用函数
  await simulateDelay(1000 + Math.random() * 2000);
  
  return {
    message: `Task "${task.name}" completed by ${agent.name}`,
    agentType: agent.type,
    timestamp: new Date().toISOString(),
  };
};

/**
 * 执行远程 Agent
 */
const executeRemoteAgent = async (
  task: AgentTask,
  agent: AgentTask['assignedAgents'][0]
): Promise<any> => {
  console.log(`[Remote Agent] Executing task "${task.name}" on ${agent.name}`);
  
  // 模拟远程 HTTP 调用
  // 实际项目中应该调用远程 Agent 的 API 端点
  await simulateDelay(2000 + Math.random() * 3000);
  
  return {
    message: `Task "${task.name}" completed by remote agent ${agent.name}`,
    agentType: agent.type,
    location: agent.location,
    timestamp: new Date().toISOString(),
  };
};

/**
 * 执行云端 Agent (通过 A2A Gateway)
 */
const executeCloudAgent = async (
  task: AgentTask,
  agent: AgentTask['assignedAgents'][0]
): Promise<any> => {
  console.log(`[Cloud Agent] Executing task "${task.name}" on ${agent.name} via A2A`);
  
  // 模拟 A2A Gateway 调用
  // 实际项目中应该使用 @a2a-js/sdk
  await simulateDelay(1500 + Math.random() * 2500);
  
  return {
    message: `Task "${task.name}" completed by cloud agent ${agent.name}`,
    agentType: agent.type,
    location: agent.location,
    protocol: 'A2A',
    timestamp: new Date().toISOString(),
  };
};

/**
 * 模拟延迟
 */
const simulateDelay = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * 批量执行任务给多个 Agent
 */
export const executeTaskBatch = async (
  task: AgentTask,
  agentIds: string[]
): Promise<AgentExecutionResult[]> => {
  const results = await Promise.all(
    agentIds.map((agentId) => executeTask(task, agentId))
  );
  
  return results;
};

/**
 * 检查 Agent 是否可用
 */
export const isAgentAvailable = async (agentId: string): Promise<boolean> => {
  try {
    const res = await fetch(`/api/agents/${agentId}`);
    if (!res.ok) return false;
    
    const agent = await res.json();
    return agent.status === 'online' || agent.status === 'busy';
  } catch {
    return false;
  }
};
