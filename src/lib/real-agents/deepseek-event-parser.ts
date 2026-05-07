import type { HarnessToolEvent } from '@/lib/acpx/types';
import { buildToolPreview, getToolEmoji } from '@/lib/acpx/tool-emojis';

export interface DeepSeekRuntimeItemLike {
  id: string;
  kind?: string;
  status?: string;
  summary?: string;
  detail?: string;
}

const DEEPSEEK_TOOL_NAME_MAP: Record<string, string> = {
  exec_shell: 'Bash',
  run_shell: 'Bash',
  bash: 'Bash',
  command_execution: 'Bash',
  read_file: 'Read',
  read_files: 'Read',
  write_file: 'Write',
  write_files: 'Write',
  patch_file: 'Edit',
  apply_patch: 'Edit',
  edit_file: 'Edit',
  multi_edit: 'MultiEdit',
  grep: 'Grep',
  search_files: 'Grep',
  glob: 'Glob',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  task: 'Task',
};

const normalizeToolName = (rawToolName: string) => {
  const trimmed = rawToolName.trim();
  if (!trimmed) {
    return 'Task';
  }

  return DEEPSEEK_TOOL_NAME_MAP[trimmed] ?? DEEPSEEK_TOOL_NAME_MAP[trimmed.toLowerCase()] ?? trimmed;
};

const splitSummaryToolPrefix = (text: string) => {
  const trimmed = text.trim();
  const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*([\s\S]*)$/);
  if (!match) {
    return null;
  }

  return {
    rawToolName: match[1],
    rest: match[2].trim(),
  };
};

const tryParseJsonObject = (text: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const stripLeadingFailurePrefix = (text: string) =>
  text
    .replace(/^[A-Za-z0-9_.-]+\s+failed:\s*/i, '')
    .replace(/^failed:\s*/i, '')
    .trim();

export const buildDeepSeekToolEvent = (
  item: DeepSeekRuntimeItemLike
): HarnessToolEvent | null => {
  if (item.kind === 'tool_call') {
    const summaryInfo = item.summary ? splitSummaryToolPrefix(item.summary) : null;
    const toolName = normalizeToolName(summaryInfo?.rawToolName || 'Task');
    const detailObject = item.detail ? tryParseJsonObject(item.detail) : null;
    const preview =
      (detailObject ? buildToolPreview(detailObject) : '') ||
      summaryInfo?.rest ||
      item.detail?.trim() ||
      '';

    return {
      toolName,
      preview,
      emoji: getToolEmoji(toolName),
    };
  }

  if (item.kind === 'command_execution') {
    const preview =
      stripLeadingFailurePrefix(item.detail?.trim() || '') ||
      stripLeadingFailurePrefix(item.summary?.trim() || '');

    return {
      toolName: 'Bash',
      preview,
      emoji: getToolEmoji('Bash'),
    };
  }

  return null;
};

export const extractDeepSeekStatusText = (item: DeepSeekRuntimeItemLike): string | null => {
  if (item.kind !== 'status') {
    return null;
  }

  const text = item.detail?.trim() || item.summary?.trim() || '';
  return text || null;
};
