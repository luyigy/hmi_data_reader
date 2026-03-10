export type AgentRef = {
  id?: string;
  name: string;
  location?: 'local' | 'remote' | string;
};

const mentionRegex = /@([a-zA-Z0-9_-]+)/g;

export const parseMentions = (text: string) => {
  const mentions = new Set<string>();
  if (!text) return [];

  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(text)) !== null) {
    if (match[1]) mentions.add(match[1]);
  }

  return Array.from(mentions);
};

export const matchMentionedAgents = (
  text: string,
  agents: AgentRef[]
): AgentRef[] => {
  const mentions = parseMentions(text).map((name) => name.toLowerCase());
  if (!mentions.length) return [];

  return agents.filter((agent) =>
    mentions.includes(agent.name.toLowerCase())
  );
};
