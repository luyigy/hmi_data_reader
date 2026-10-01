import type { HarnessStreamCallbacks } from '@/lib/acpx/types';
import { createStreamWriteBuffer } from '@/lib/acpx/stream-write-buffer';
import { FeishuProgressTracker, type FeishuProgressTarget } from '@/lib/feishu-progress';
import { PROGRESS_HEARTBEAT_MS, redactHarnessOutput, sanitizePreview } from '@/lib/acpx/harness-events';

export const attachLiveRoomStructuredOutput = async ({ progressTarget, displayName }: {
  progressTarget: FeishuProgressTarget | null;
  displayName: string;
}) => {
  const progressTracker = progressTarget ? new FeishuProgressTracker(progressTarget, process.cwd(), displayName) : null;
  let tail = '';
  let text = '';
  let response = '';
  let details = '';
  let usage = '';
  const tools: string[] = [];
  const toolSteps = new Set<string>();
  const preview = (value: unknown) => sanitizePreview(value, { workspaceRoot: process.cwd() });
  const appendDetails = (value: string) => {
    // Keep recent process text; the runner already persists the complete event stream.
    details = Array.from(details + value).slice(-3000).join('');
  };
  const processLine = (line: string) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== 'object') return;
    if (event.event === 'init') {
      // A steering restart begins a new stream on the same answer card.
      text = '';
      response = '';
      usage = '';
      toolSteps.clear();
    }
    if (event.event === 'step_update' && event.step_update) {
      const step = event.step_update;
      if (typeof step.text_delta === 'string' && step.step_type !== 'user_input') {
        appendDetails(step.text_delta);
        if (!step.step_type || step.step_type === 'agent_response') {
          if (response) text = '';
          response = '';
          text += step.text_delta;
        }
      }
      const toolName = step.tool_name ?? step.function_name;
      if (typeof toolName === 'string') {
        const key = step.step_index == null ? null : `${step.step_index}:${toolName}`;
        if (!key || !toolSteps.has(key)) {
          if (key) toolSteps.add(key);
          tools.push(`🛠️ ${preview(toolName)}：${preview(step.tool_info?.parameters ?? step.arguments ?? '')}`);
          if (tools.length > 5) tools.shift();
        }
      }
    }
    if (event.event === 'result' && event.result) {
      const result = event.result;
      if (typeof result.response === 'string') response = result.response.trim();
      const parts: string[] = [];
      for (const [key, label] of [
        ['input_tokens', '输入'], ['output_tokens', '输出'], ['total_tokens', '总计'],
      ]) {
        const count = result.usage?.[key];
        if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
          parts.push(`${label} ${count} tokens`);
        }
      }
      if (!parts.length) parts.push('Token 用量未提供');
      if (typeof result.duration_seconds === 'number' && Number.isFinite(result.duration_seconds) && result.duration_seconds >= 0) {
        parts.push(`CLI 报告耗时 ${result.duration_seconds.toFixed(2)}秒`);
      }
      usage = parts.join(' · ');
    }
  };
  const update = () => progressTracker?.setReplyContent(
    redactHarnessOutput(response || text || `${preview(displayName)} 正在处理信息…`),
    redactHarnessOutput([tools.length ? `最近工具调用：\n${tools.join('\n')}` : '', details ? `最近过程文本：\n${details}` : ''].filter(Boolean).join('\n\n')),
    usage,
  );
  // Show the same reply card before the CLI emits its first complete event.
  const reportUpdateError = (error: unknown) => console.error('[LiveRoomStructuredOutput] card update failed:', error);
  await update()?.catch(reportUpdateError);
  const heartbeatTimer = progressTracker ? setInterval(() => {
    void update()?.catch(reportUpdateError);
  }, PROGRESS_HEARTBEAT_MS) : undefined;
  heartbeatTimer?.unref();
  const writes = createStreamWriteBuffer(async (batch) => {
    for (const { content } of batch) {
      for (const line of content.split('\n')) processLine(line);
    }
    await update();
  }, 1000);
  const enqueue = (chunk: string, final = false) => {
    tail += chunk;
    const end = final ? tail.length : tail.lastIndexOf('\n') + 1;
    if (!end) return;
    writes.push({ stream: 'stdout', content: tail.slice(0, end), interactionDetected: false });
    tail = tail.slice(end);
  };
  const streamCallbacks: HarnessStreamCallbacks = {
    onStdoutChunk: chunk => enqueue(chunk),
    // Diagnostics stay in persisted run events, never become chat messages.
  };
  return {
    streamCallbacks,
    progressTracker,
    dispose: async (summary: string, success: boolean) => {
      clearInterval(heartbeatTimer);
      enqueue('', true);
      await writes.drain();
      if (!success) {
        response = /^\s*[{[]/.test(summary) ? '执行失败，请查看任务室运行记录。' : summary;
      }
      if (!response && !text) response = success ? '执行完成，未返回回答文本。' : '执行失败，请查看任务室运行记录。';
      await update();
      await progressTracker?.finalize(summary, success);
    },
  };
};
