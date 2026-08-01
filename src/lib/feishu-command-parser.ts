import type { ParsedFeishuMessage } from '@/lib/feishu-message-content';

export type ParsedFeishuCommand = {
  command: 'help' | 'menu' | 'status' | 'users' | 'user' | 'gateways' | 'agents' | 'hosts' | 'run' | 'register' | 'room' | 'handoff-limit' | 'mode' | 'members' | 'nick' | 'role' | 'restrict' | 'codex-config' | 'speaker' | 'kick' | 'add' | 'chat' | 'plan' | 'doc' | 'approvals' | 'approve' | 'deny' | 'answer' | 'grant' | 'rights' | 'handover' | 'workspace' | 'workflow' | 'inbox' | 'new-session' | 'stop' | 'sessions' | 'jobs' | 'job';
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
  const cleanedText = stripBotMention(message.text);
  const firstLine = cleanedText.split(/\r?\n/, 1)[0].trim();
  const commandSource = /^\/ap\s+add(?:\s|$)/i.test(firstLine) ? firstLine : cleanedText;
  const normalized = commandSource.replace(/\s+/g, ' ').trim();

  const lower = normalized.toLowerCase();
  let commandText: string;
  if (lower.startsWith('/ap ')) {
    commandText = normalized.slice(4).trim();
  } else if (lower === '/ap') {
    commandText = 'help';
  } else {
    return null;
  }

  if (!commandText) {
    return { command: 'help', args: [], options: {} };
  }

  const normalizedTokens = tokenizeCommandText(commandText);

  const [rawCommand = 'help', ...rest] = normalizedTokens;
  const commandAlias = rawCommand.toLowerCase();
  const command = commandAlias === 'new'
    ? 'new-session'
    : commandAlias === 'dashboard'
      ? 'job'
      : commandAlias;
  if (!['help', 'menu', 'status', 'users', 'user', 'gateways', 'agents', 'hosts', 'run', 'register', 'room', 'handoff-limit', 'mode', 'members', 'nick', 'role', 'restrict', 'codex-config', 'speaker', 'kick', 'add', 'chat', 'plan', 'doc', 'approvals', 'approve', 'deny', 'answer', 'grant', 'rights', 'handover', 'workspace', 'workflow', 'inbox', 'new-session', 'stop', 'sessions', 'jobs', 'job'].includes(command)) {
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

  if (commandAlias === 'dashboard') {
    args.unshift('dashboard');
    if (args.length === 1) args.push('workflow-watcher');
  }

  return {
    command: command as ParsedFeishuCommand['command'],
    args,
    options,
  };
}
