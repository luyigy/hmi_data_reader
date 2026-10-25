import type { HarnessToolEvent } from '../acpx/types';

/** Result classification comes from native fields, never command output or model prose. */
export function completedCodexToolEvent(item: Record<string, unknown> | undefined): HarnessToolEvent | null {
  if (!item || !['commandExecution', 'mcpToolCall', 'fileChange'].includes(String(item.type))) return null;
  const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined;
  const result = item.result && typeof item.result === 'object' ? item.result as Record<string, unknown> : undefined;
  const failed = item.status === 'failed' || item.status === 'declined' || Boolean(item.error) || result?.isError === true || exitCode !== undefined && exitCode !== 0;
  return { toolName: item.type === 'commandExecution' ? 'Bash' : item.type === 'fileChange' ? 'Edit' : String(item.tool || 'MCP'),
    preview: failed ? `工具执行失败${exitCode !== undefined ? `，退出码 ${exitCode}` : ''}` : '工具执行完成',
    emoji: failed ? '❌' : '✅', status: failed ? 'failed' : 'completed',
    ...(typeof item.id === 'string' ? { toolCallId: item.id } : {}), ...(exitCode !== undefined ? { exitCode } : {}) };
}
