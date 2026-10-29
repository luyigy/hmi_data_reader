import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { wrapWithBubblewrap } from '@/lib/harness/bubblewrap';
import { redactHarnessOutput, sanitizePreview } from '@/lib/acpx/harness-events';
import { buildToolPreview, getToolEmoji } from '@/lib/acpx/tool-emojis';
import type { HarnessSteer } from '@/lib/acpx/types';
import type { KimiCodeConfig } from './kimi-code-agent';

interface Options extends KimiCodeConfig {
  binary: string;
  env: NodeJS.ProcessEnv;
  configPaths: string[];
  prompt: string;
  workingDirectory: string;
}
type Receipt = Awaited<ReturnType<HarnessSteer>>;

export const kimiServerEnabled = () => process.env.KIMI_CODE_TRANSPORT !== 'print';

function resolveBinary(binary: string, env: NodeJS.ProcessEnv) {
  if (binary.includes('/')) return realpathSync(binary);
  const found = (env.PATH || '').split(path.delimiter).map(dir => path.join(dir, binary)).find(existsSync);
  if (!found) throw new Error(`找不到本地 harness：${binary}`);
  return realpathSync(found);
}

/** Private Kimi protocol bridge runs inside the very same permission boundary as the CLI. */
export async function runKimiServer(options: Options): Promise<{ output: string; sessionId?: string }> {
  const binary = resolveBinary(options.binary, options.env);
  const bridgeDirectory = path.join(process.cwd(), 'scripts/kimi-session');
  const wrapped = wrapWithBubblewrap({
    command: process.execPath, commandArgs: [path.join(bridgeDirectory, 'bridge.cjs')],
    cwd: options.workingDirectory, workspaceRoot: options.workspaceRoot,
    writableRoots: options.extraWritableRoots, networkAccess: options.networkAccess,
    sandboxMode: options.sandboxMode, env: options.env, configPaths: options.configPaths,
    readOnlyPaths: [...options.extraReadOnlyPaths || [], bridgeDirectory, binary],
  });
  const child = spawn(wrapped.command, wrapped.args, {
    cwd: options.workingDirectory, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  const safe = redactHarnessOutput;
  const preview = (text: string) => sanitizePreview(text, { workspaceRoot: options.workspaceRoot || options.workingDirectory });
  return new Promise((resolve, reject) => {
    let error: Error | undefined, result: { output: string; sessionId?: string } | undefined;
    let accepting = false, closed = false, buffer = '', stderr = '', idle: number | undefined;
    let unregister: (() => void) | undefined;
    let timeout: NodeJS.Timeout | undefined, forceKill: NodeJS.Timeout | undefined;
    let callbacks = Promise.resolve();
    const pending = new Map<string, { resolve: (value: Receipt) => void; timer: NodeJS.Timeout }>();
    const receipts = new Map<string, Promise<Receipt>>();
    const send = (value: object) => child.stdin.write(JSON.stringify(value) + '\n');
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal); } catch { child.kill(signal); }
    };
    const fail = (cause: unknown) => {
      if (closed || error) return;
      error = cause instanceof Error ? cause : new Error(String(cause));
      accepting = false;
      kill('SIGTERM');
      forceKill = setTimeout(() => kill('SIGKILL'), 2000);
      forceKill.unref();
    };
    const finish = () => {
      if (idle === undefined || pending.size || closed || error) return;
      accepting = false;
      send({ type: 'finish', revision: idle });
      idle = undefined;
    };
    const steer: HarnessSteer = (id, text) => {
      const known = receipts.get(id);
      if (known) return known;
      if (!accepting || closed || error) return Promise.resolve('rejected');
      idle = undefined;
      const receipt = new Promise<Receipt>(resolveReceipt => {
        const timer = setTimeout(() => {
          pending.delete(id); resolveReceipt('unknown');
          fail(new Error('Kimi steering receipt timed out; delivery is uncertain and must not be replayed.'));
        }, 20000);
        pending.set(id, { resolve: resolveReceipt, timer });
        send({ type: 'steer', id, text });
      });
      receipts.set(id, receipt);
      return receipt;
    };
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 8 * 1024 * 1024) { fail(new Error('Kimi bridge frame exceeded limit.')); return; }
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        callbacks = callbacks.then(async () => {
          if (error) return;
          const event = JSON.parse(line);
          switch (event.type) {
            case 'session': await options.onSessionStarted?.(event.sessionId); break;
            case 'ready': accepting = true; unregister = options.streamCallbacks?.onSteeringReady?.(steer); break;
            case 'progress': await options.streamCallbacks?.onStdoutChunk?.(safe(event.text), { id: event.id, phase: event.phase, operation: 'replace' }); break;
            case 'subagent': await options.streamCallbacks?.onSubagentEvent?.({ ...event.info, description: preview(event.info.description) }); break;
            case 'tool': await options.streamCallbacks?.onToolEvent?.({
              toolName: event.name, toolCallId: event.id, status: event.completed ? (event.failed ? 'failed' : 'completed') : undefined,
              emoji: event.failed ? '❌' : event.completed ? '✅' : getToolEmoji(event.name),
              preview: event.completed ? '' : preview(buildToolPreview(event.input)),
            }); break;
            case 'receipt': {
              const request = pending.get(event.id);
              if (request) {
                clearTimeout(request.timer); pending.delete(event.id);
                request.resolve(['accepted', 'rejected', 'unknown'].includes(event.status) ? event.status : 'unknown');
              }
              break;
            }
            case 'idle': idle = event.revision; finish(); break;
            case 'result': result = { output: safe(event.output), sessionId: event.sessionId }; break;
            case 'error': fail(new Error(safe(event.message))); break;
            default: fail(new Error('Unknown Kimi bridge event.'));
          }
        });
        void callbacks.catch(fail);
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.stdin.on('error', fail);
    child.on('error', fail);
    child.on('close', (code, signal) => {
      closed = true; accepting = false;
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      for (const request of Array.from(pending.values())) { clearTimeout(request.timer); request.resolve('unknown'); }
      pending.clear();
      void callbacks.then(() => {
        unregister?.();
        if (error) reject(error);
        else if (code !== 0 || !result) reject(new Error(`Kimi bridge ended (${signal || code}): ${safe(stderr) || 'no completion receipt'}`));
        else resolve(result);
      }).catch(cause => { unregister?.(); reject(cause); });
    });
    if (typeof options.timeout === 'number' && options.timeout > 0) timeout = setTimeout(() => fail(new Error(`Kimi Code execution timed out after ${options.timeout}ms`)), options.timeout);
    try {
      options.onSpawn?.(child as ChildProcess);
      send({ type: 'start', binary, cwd: options.workingDirectory, prompt: options.prompt, sessionId: options.sessionId, model: options.model, thinking: options.reasoningEffort });
    } catch (cause) { fail(cause); }
  });
}
