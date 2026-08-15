import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const source = await readFile(path.join(process.cwd(), 'scripts/agent-platform-runner.js'), 'utf8');
  // Strip the shebang before prepending the server bootstrap: a `#!` on any line
  // but the first is a fatal SyntaxError for `node -` (stdin) and `node file.js`.
  const body = source.replace(/^#![^\n]*\n?/, '');
  return new Response(`process.env.AGENT_PLATFORM_SERVER=${JSON.stringify(new URL(request.url).origin)};\n${body}`, {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
  });
}
