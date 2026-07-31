import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const prepareFeishuMarkdown = (content: string) =>
  content
    .replace(/^---\n[\s\S]*?\n---\n*/, '')
    .replace(/^# [^\n]*\n*/, '');

export async function importMarkdownAsFeishuDocument(args: {
  content: string;
  name: string;
  signal?: AbortSignal;
}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-platform-doc-'));
  try {
    await writeFile(
      path.join(directory, 'plan.md'),
      prepareFeishuMarkdown(args.content),
    );
    const result = await execFileAsync('lark-cli', [
      'docs', '+create', '--as', 'bot', '--api-version', 'v2',
      '--title', args.name,
      '--doc-format', 'markdown', '--content', '@plan.md', '--format', 'json',
    ], {
      cwd: directory,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      signal: args.signal,
    });
    const parsed = JSON.parse(result.stdout) as {
      ok?: boolean;
      data?: { document?: { url?: unknown } };
    };
    const url = parsed.data?.document?.url;
    if (parsed.ok !== true || typeof url !== 'string' || !url) {
      throw new Error('Feishu document creation returned no document URL');
    }
    return url;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
