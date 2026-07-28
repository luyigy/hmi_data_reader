import type { ParsedFeishuMessage } from '@/lib/feishu-message-content';

export type ParsedFeishuCommand = {
  command: 'help' | 'status' | 'users' | 'user' | 'gateways' | 'agents' | 'hosts' | 'run' | 'register' | 'room' | 'mode' | 'members' | 'nick' | 'role' | 'codex-config' | 'speaker' | 'kick' | 'add' | 'chat' | 'plan' | 'approvals' | 'approve' | 'deny' | 'answer' | 'grant' | 'rights' | 'handover' | 'workspace' | 'new-session' | 'stop' | 'sessions' | 'jobs' | 'job';
  args: string[];
  options: Record<string, string>;
};

function stripBotMention(text: string): string {
  return text
    .replace(/<at user_id="[^"]+">[^<]+<\/at>/g, '')
    .replace(/^@\S+\s*/, '')
    .trim();
}

function tokenizeCommandText(input: string) {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export function parseFeishuCommand(message: ParsedFeishuMessage): ParsedFeishuCommand | null {
  const botOpenId = process.env.FEISHU_BOT_OPEN_ID?.trim() || undefined;
  const hasBotMention = botOpenId ? message.mentions.includes(botOpenId) : false;
  const cleanedText = stripBotMention(message.text);
  const normalized = cleanedText.replace(/\s+/g, ' ').trim();

  let commandText = normalized;
  const lower = normalized.toLowerCase();
  if (lower.startsWith('/ap ')) {
    commandText = normalized.slice(4).trim();
  } else if (lower === '/ap') {
    commandText = 'help';
  } else if (lower.startsWith('ap ')) {
    commandText = normalized.slice(3).trim();
  } else if (hasBotMention) {
    commandText = normalized || 'help';
  } else if (message.chatType !== 'p2p') {
    return null;
  }

  if (!commandText) {
    return { command: 'help', args: [], options: {} };
  }

  const normalizedTokens = tokenizeCommandText(commandText);

  const [rawCommand = 'help', ...rest] = normalizedTokens;
  const commandAlias = rawCommand.toLowerCase();
  const command = commandAlias === 'new' ? 'new-session' : commandAlias;
  if (!['help', 'status', 'users', 'user', 'gateways', 'agents', 'hosts', 'run', 'register', 'room', 'mode', 'members', 'nick', 'role', 'codex-config', 'speaker', 'kick', 'add', 'chat', 'plan', 'approvals', 'approve', 'deny', 'answer', 'grant', 'rights', 'handover', 'workspace', 'new-session', 'stop', 'sessions', 'jobs', 'job'].includes(command)) {
    return null;
  }

  const args: string[] = [];
  const options: Record<string, string> = {};

  for (const token of rest) {
    if (token.startsWith('--')) {
      const optionText = token.slice(2);
      const separatorIndex = optionText.indexOf('=');
      if (separatorIndex > 0) {
        const key = optionText.slice(0, separatorIndex);
        const value = optionText.slice(separatorIndex + 1);
        options[key] = value;
      } else if (optionText) {
        options[optionText] = 'true';
      }
    } else {
      args.push(token);
    }
  }

  return {
    command: command as ParsedFeishuCommand['command'],
    args,
    options,
  };
}
