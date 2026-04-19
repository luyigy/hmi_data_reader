import type { HarnessStreamCallbacks, HarnessToolEvent } from '@/lib/acpx/types';
import { buildToolPreview, getToolEmoji } from '@/lib/acpx/tool-emojis';

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  last_agent_message?: string;
  error?: {
    message?: string;
  };
  item?: {
    type?: string;
    text?: string;
    command?: string;
    cwd?: string;
    parsed_cmd?: unknown;
    invocation?: {
      server?: string;
      tool?: string;
      arguments?: unknown;
    };
    changes?: unknown;
    query?: string;
  };
  command?: string;
  cwd?: string;
  parsed_cmd?: unknown;
  invocation?: {
    server?: string;
    tool?: string;
    arguments?: unknown;
  };
  changes?: unknown;
  query?: string;
}

export interface ParsedCodexJsonLine {
  threadId?: string;
  turnFailureMessage?: string;
  resolvedText?: string;
  plainText?: string;
}

const summarizePatchChanges = (changes: unknown): string => {
  if (!Array.isArray(changes) || changes.length === 0) {
    return '';
  }

  const labels = changes
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const path = record.file_path || record.path || record.relative_path;
      return typeof path === 'string' && path.trim() ? path.trim() : null;
    })
    .filter((value): value is string => Boolean(value));

  if (labels.length === 0) {
    return `patch ${changes.length} change${changes.length > 1 ? 's' : ''}`;
  }

  const preview = labels.slice(0, 3).join(', ');
  return labels.length > 3 ? `${preview} +${labels.length - 3} more` : preview;
};

const buildCodexToolEvent = (event: CodexJsonEvent): HarnessToolEvent | null => {
  switch (event.type) {
    case 'exec_command_begin': {
      const preview = buildToolPreview({
        command: event.command,
        cwd: event.cwd,
        parsed_cmd: event.parsed_cmd,
      });
      return {
        toolName: 'Bash',
        preview,
        emoji: getToolEmoji('Bash'),
      };
    }
    case 'patch_apply_begin': {
      const preview = summarizePatchChanges(event.changes);
      return {
        toolName: 'Edit',
        preview,
        emoji: getToolEmoji('Edit'),
      };
    }
    case 'web_search_end': {
      const preview = typeof event.query === 'string' ? event.query.trim() : '';
      return {
        toolName: 'WebSearch',
        preview,
        emoji: getToolEmoji('WebSearch'),
      };
    }
    case 'mcp_tool_call_begin': {
      const toolName = event.invocation?.tool?.trim() || 'Task';
      const preview =
        buildToolPreview(event.invocation?.arguments) ||
        [event.invocation?.server, event.invocation?.tool].filter(Boolean).join(' / ');
      return {
        toolName,
        preview,
        emoji: getToolEmoji(toolName),
      };
    }
    default:
      return null;
  }
};

const extractAgentText = (event: CodexJsonEvent): string | null => {
  if (
    event.type === 'item.completed'
    && (event.item?.type === 'agent_message' || event.item?.type === 'assistant_message')
    && typeof event.item.text === 'string'
  ) {
    return event.item.text;
  }

  if (event.type === 'agent_message' && typeof event.item?.text === 'string') {
    return event.item.text;
  }

  if (typeof event.last_agent_message === 'string' && event.last_agent_message.trim()) {
    return event.last_agent_message;
  }

  return null;
};

export function processCodexJsonLine(
  line: string,
  callbacks?: HarnessStreamCallbacks
): ParsedCodexJsonLine {
  const trimmed = line.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const event = JSON.parse(trimmed) as CodexJsonEvent;
    const toolEvent = buildCodexToolEvent(event);
    if (toolEvent) {
      void callbacks?.onToolEvent?.(toolEvent);
    }

    return {
      threadId:
        typeof event.thread_id === 'string' && event.thread_id.trim()
          ? event.thread_id.trim()
          : undefined,
      turnFailureMessage:
        event.type === 'turn.failed'
          ? event.error?.message || event.message || 'Codex turn failed'
          : undefined,
      resolvedText: extractAgentText(event) || undefined,
    };
  } catch {
    return { plainText: trimmed };
  }
}
