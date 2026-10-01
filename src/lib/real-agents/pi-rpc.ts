import { spawn, type ChildProcess } from 'node:child_process';
import type { HarnessSteer, HarnessStreamCallbacks } from '@/lib/acpx/types';

type Reply = { success?: boolean; error?: string; data?: {
  isStreaming?: boolean; isCompacting?: boolean; pendingMessageCount?: number;
  sessionFile?: string; sessionId?: string;
} };

// RPC is opt-in for local Live Room Pi. Other callers keep their existing transport.
export function runPiRpc(options: {
  binary: string; args: string[]; prompt: string; timeout: number | null;
  workingDirectory: string; streamCallbacks: HarnessStreamCallbacks;
  onSpawn?: (child: ChildProcess) => void; onEvent: (line: string) => void;
  onState?: (state: { sessionFile?: string; sessionId?: string }) => void;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.binary, options.args, {
      cwd: options.workingDirectory, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let buffer = '', stderr = '', output = '', failure = '';
    let completionError: string | undefined;
    let settled = false, active = false, ended = false, retrying = false, checking = false;
    let revision = 0, sequence = 0, inFlight = 0;
    let unregister: (() => void) | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const pending = new Map<string, (reply?: Reply) => void>();
    const messages = new Map<string, ReturnType<HarnessSteer>>();
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* Already exited. */ }
    };

    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      completionError = error;
      active = false;
      unregister?.();
      clearTimeout(deadline);
      clearTimeout(poll);
      pending.forEach((done) => done());
      pending.clear();
      child.stdin.end();
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1_000);
      killTimer.unref();
    };

    const request = (command: Record<string, unknown>): Promise<Reply | undefined> => {
      if (settled || child.stdin.destroyed || !child.stdin.writable) return Promise.resolve(undefined);
      const id = `ap-${++sequence}`;
      return new Promise((done) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          done(undefined);
        }, 5_000);
        pending.set(id, (reply) => { clearTimeout(timer); done(reply); });
        child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
          if (error) { pending.get(id)?.(); pending.delete(id); }
        });
      });
    };

    const checkEnd = async () => {
      if (settled || !ended || retrying || checking || inFlight) return;
      checking = true;
      const currentRevision = revision;
      const state = await request({ type: 'get_state' });
      checking = false;
      if (settled) return;
      if (!state?.success) { finish('Pi RPC completion state unavailable'); return; }
      if (currentRevision !== revision || !ended || retrying || inFlight
        || state.data?.isStreaming || state.data?.isCompacting || state.data?.pendingMessageCount) {
        poll = setTimeout(() => { void checkEnd(); }, 25);
        return;
      }
      options.onState?.(state.data || {});
      finish(failure || (!output.trim() ? 'Pi Agent returned an empty response' : undefined));
    };

    const steer: HarnessSteer = (messageId, message) => {
      const previous = messages.get(messageId);
      if (previous) return previous;
      if (!active || settled) return Promise.resolve('rejected');
      revision++;
      inFlight++;
      // prompt+steer also starts a turn if Pi became idle before reading stdin.
      // The plain steer command would leave that message stranded in Pi's queue.
      const result = request({ type: 'prompt', message, streamingBehavior: 'steer' })
        .then((reply) => {
          inFlight--;
          void checkEnd();
          return !reply ? 'unknown' as const : reply.success ? 'accepted' as const : 'rejected' as const;
        });
      messages.set(messageId, result);
      return result;
    };

    child.stdin.on('error', (error) => finish(`Pi RPC stdin failed: ${error.message}`));
    child.on('error', (error) => finish(error.message));
    child.on('exit', (code, signal) => {
      if (!settled) finish(stderr.trim() || `Pi RPC exited before completion (${signal || code})`);
    });
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (!settled) finish(stderr.trim() || `Pi RPC exited before completion (${signal || code})`);
      clearTimeout(killTimer);
      if (completionError) reject(new Error(completionError));
      else resolve(output);
    });
    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk.toString();
      void options.streamCallbacks.onStderrChunk?.(chunk.toString());
    });
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (settled || !line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { finish('Invalid Pi RPC JSON'); return; }
        if (event.type === 'response') {
          pending.get(event.id)?.(event);
          pending.delete(event.id);
          continue;
        }
        options.onEvent(line);
        if (event.type === 'agent_start') {
          active = true;
          ended = false;
          revision++;
          unregister ??= options.streamCallbacks.onSteeringReady?.(steer);
        }
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          output = (event.message.content || []).filter((part: { type: string }) => part.type === 'text')
            .map((part: { text: string }) => part.text).join('');
          const stop = event.message.stopReason || event.stopReason;
          failure = stop === 'error' || stop === 'aborted'
            ? event.message.errorMessage || event.errorMessage || `Pi Agent ${stop}` : '';
        }
        if (event.type === 'auto_retry_start') { retrying = true; active = false; }
        if (event.type === 'auto_compaction_start') active = false;
        if (event.type === 'auto_retry_end') {
          retrying = false;
          if (!event.success) failure = event.finalError || failure || 'Pi Agent retry exhausted';
        }
        if (event.type === 'agent_end') { ended = true; active = false; }
      }
      void checkEnd();
    });
    options.onSpawn?.(child);
    if (options.timeout !== null) deadline = setTimeout(
      () => finish(`Pi Agent execution timed out after ${options.timeout}ms`), options.timeout,
    );
    void request({ type: 'prompt', message: options.prompt }).then((reply) => {
      if (!reply?.success) finish(reply?.error || 'Pi RPC initial prompt acknowledgement unavailable');
    });
  });
}
