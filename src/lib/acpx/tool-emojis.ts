const TOOL_EMOJI_MAP: Record<string, string> = {
  Bash: '💻',
  Read: '📖',
  Write: '✍️',
  Edit: '🔧',
  Grep: '🔎',
  Glob: '🔎',
  WebSearch: '🌐',
  WebFetch: '🌐',
  Task: '🤖',
  Agent: '🤖',
  NotebookEdit: '📓',
  MultiEdit: '🔧',
  TodoWrite: '📝',
  TodoRead: '📝',
};

const DEFAULT_EMOJI = '⚙️';

export function getToolEmoji(toolName: string): string {
  return TOOL_EMOJI_MAP[toolName] ?? DEFAULT_EMOJI;
}

export function buildToolPreview(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return '';
  }

  const obj = input as Record<string, unknown>;

  const priorityKeys = ['command', 'query', 'pattern', 'file_path', 'path', 'url', 'description', 'prompt', 'content'];
  for (const key of priorityKeys) {
    if (typeof obj[key] === 'string' && obj[key]) {
      return (obj[key] as string).trim().replace(/\n/g, ' ');
    }
  }

  const firstStringValue = Object.values(obj).find((v) => typeof v === 'string' && v);
  if (typeof firstStringValue === 'string') {
    return firstStringValue.trim().replace(/\n/g, ' ');
  }

  return '';
}
