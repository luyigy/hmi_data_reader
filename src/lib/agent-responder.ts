import { matchMentionedAgents, type AgentRef } from './mentions';

export interface AgentResponse {
  agentId: string;
  agentName: string;
  response: string;
  inReplyTo: string;
  timestamp: string;
}

/**
 * 模拟 Agent 响应
 * 实际项目中应该调用真实的 Agent API
 */
export const generateAgentResponse = async (
  message: string,
  agents: AgentRef[]
): Promise<AgentResponse[]> => {
  const mentionedAgents = matchMentionedAgents(message, agents);
  
  if (mentionedAgents.length === 0) {
    return [];
  }

  const responses: AgentResponse[] = [];
  const timestamp = new Date().toISOString();

  // 为每个被@的 Agent 生成响应
  for (const agent of mentionedAgents) {
    const response = await simulateAgentReply(agent, message);
    responses.push({
      agentId: agent.id || agent.name,
      agentName: agent.name,
      response,
      inReplyTo: message,
      timestamp,
    });
  }

  return responses;
};

/**
 * 模拟单个 Agent 的回复
 * 实际项目中应该调用 Agent 的 API 端点
 */
const simulateAgentReply = async (
  agent: AgentRef,
  userMessage: string
): Promise<string> => {
  // 模拟网络延迟
  await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1000));

  // 简单的响应模板
  const templates: Record<string, string> = {
    coding: `收到！我是 ${agent.name}，擅长编码任务。关于 "${userMessage}"，我来帮你看看...`,
    analysis: `你好，我是 ${agent.name}，负责数据分析。让我分析一下 "${userMessage}"...`,
    communication: `嗨！我是 ${agent.name}，负责沟通协调。关于你提到的 "${userMessage}"...`,
    monitoring: `${agent.name} 收到监控任务。正在检查 "${userMessage}" 相关的系统状态...`,
    operations: `我是 ${agent.name}，运维专家。让我处理 "${userMessage}" 这个需求...`,
  };

  // 根据 Agent 名称选择响应模板
  const agentType = Object.keys(templates).find((type) =>
    agent.name.toLowerCase().includes(type)
  );

  if (agentType) {
    return templates[agentType];
  }

  // 默认响应
  return `${agent.name} 收到消息："${userMessage}"。我正在处理，稍后给你回复。`;
};

/**
 * 检查消息是否@了任何 Agent
 */
export const hasAgentMention = (message: string, agents: AgentRef[]): boolean => {
  return matchMentionedAgents(message, agents).length > 0;
};
