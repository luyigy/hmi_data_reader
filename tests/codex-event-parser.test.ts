import assert from 'node:assert/strict';
import { processCodexJsonLine } from '../src/lib/real-agents/codex-event-parser';

const events: Array<{ toolName: string; preview: string; emoji: string }> = [];
const callbacks = { onToolEvent: (event: typeof events[number]) => { events.push(event); } };

processCodexJsonLine(JSON.stringify({
  type: 'item.started',
  item: { type: 'command_execution', command: 'npm test', cwd: '/repo' },
}), callbacks);
processCodexJsonLine(JSON.stringify({
  type: 'item.started',
  item: { type: 'mcp_tool_call', server: 'gitnexus', tool: 'impact', arguments: { target: 'run' } },
}), callbacks);
processCodexJsonLine(JSON.stringify({
  type: 'exec_command_begin', command: 'npm run lint', cwd: '/repo',
}), callbacks);

assert.deepEqual(events.map(({ toolName, preview }) => ({ toolName, preview })), [
  { toolName: 'Bash', preview: 'npm test' },
  { toolName: 'impact', preview: 'run' },
  { toolName: 'Bash', preview: 'npm run lint' },
]);
