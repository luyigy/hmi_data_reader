import path from 'node:path';
import { redactSensitiveText } from '../redact-sensitive';

export type NormalizedHarnessEvent = {
  kind: 'thinking' | 'assistant_text' | 'tool_use' | 'tool_result' | 'system';
  text?: string;
  toolName?: string;
  preview?: string;
  emoji?: string;
};

const MAX_PREVIEW_LENGTH = 80;
const SHORT_VALUE_KEYS = new Set(['content', 'command', 'text']);
const SENSITIVE_VALUE_KEY = /^(?:authorization|sign|hmac)$|(?:password|passwd|pwd|secret|signature|token|api[_-]?key|private[_-]?key)$/i;

const truncate = (value: string, limit = MAX_PREVIEW_LENGTH) =>
  value.length > limit ? `${value.slice(0, limit)}…` : value;

const compactValue = (value: unknown, key?: string): unknown => {
  if (typeof value === 'string') {
    return SHORT_VALUE_KEYS.has(key ?? '') ? truncate(value.split(/\r?\n\s*\r?\n/, 1)[0]) : value;
  }
  if (Array.isArray(value)) return value.map((item) => compactValue(item));
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nested]) => [
      nestedKey,
      SENSITIVE_VALUE_KEY.test(nestedKey) ? '[REDACTED]' : compactValue(nested, nestedKey.toLowerCase()),
    ]));
  }
  return value;
};

const stringifyPreview = (value: unknown) => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(compactValue(value));
  } catch {
    return String(value);
  }
};

const normalizePaths = (value: string, workspaceRoot: string) => {
  const root = path.resolve(workspaceRoot);
  return value.replace(/(?:(?<![\w])[A-Za-z]:[\\/]|(?<![\w:/])\/)[^\s"'`,;)}\]]+/g, (absolutePath) => {
    const windowsPath = /^[A-Za-z]:[\\/]/.test(absolutePath);
    const api = windowsPath ? path.win32 : path;
    if (!windowsPath && (absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`))) {
      return path.relative(root, absolutePath) || '.';
    }
    return api.basename(absolutePath);
  });
};

export const sanitizePreview = (value: unknown, { workspaceRoot }: { workspaceRoot: string }) => {
  const redacted = redactSensitiveText(stringifyPreview(value))
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/gi, '[REDACTED]')
    .replace(/(\bbearer\s+)[^\s,;"'}]+/gi, '$1[REDACTED]')
    .replace(/(\b(?:signature|sign|hmac)\b\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/gi, '$1[REDACTED]')
    .replace(/\b([A-Z][A-Z0-9_]{2,}=)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/g, '$1[REDACTED]');
  return truncate(normalizePaths(redacted, workspaceRoot));
};

const signature = (event: NormalizedHarnessEvent) => JSON.stringify([
  event.kind,
  event.toolName,
  event.text,
  event.preview,
]);

const withCount = (event: NormalizedHarnessEvent, count: number): NormalizedHarnessEvent => count > 1
  ? { ...event, preview: `${event.preview ?? ''} ×${count}`.trim() }
  : event;

export const createProgressDedupe = ({
  toolMinMs,
  thinkingMinMs,
}: {
  toolMinMs: number;
  thinkingMinMs: number;
}) => {
  let pendingTool: { event: NormalizedHarnessEvent; signature: string; count: number; at: number } | null = null;
  let lastThinking: { signature: string; at: number } | null = null;
  const lastSignatures = new Map<NormalizedHarnessEvent['kind'], string>();

  const flush = (): NormalizedHarnessEvent | null => {
    if (!pendingTool) return null;
    const result = withCount(pendingTool.event, pendingTool.count);
    pendingTool = null;
    return result;
  };

  const consume = (event: NormalizedHarnessEvent): NormalizedHarnessEvent | null => {
    const eventSignature = signature(event);
    const now = Date.now();

    if (event.kind === 'tool_use' || event.kind === 'tool_result') {
      if (pendingTool && pendingTool.signature === eventSignature && now - pendingTool.at < toolMinMs) {
        pendingTool.count += 1;
        pendingTool.at = now;
        return null;
      }
      const ready = flush();
      pendingTool = { event, signature: eventSignature, count: 1, at: now };
      return ready;
    }

    if (event.kind === 'thinking') {
      if (lastThinking?.signature === eventSignature
        || (lastThinking && now - lastThinking.at < thinkingMinMs)) return null;
      lastThinking = { signature: eventSignature, at: now };
      return event;
    }

    if (lastSignatures.get(event.kind) === eventSignature) return null;
    lastSignatures.set(event.kind, eventSignature);
    return event;
  };

  return { consume, flush };
};
