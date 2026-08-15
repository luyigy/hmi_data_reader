import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { requestOrigin } from '@/lib/pairing-tickets';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const source = await readFile(path.join(process.cwd(), 'scripts/agent-platform-runner.js'), 'utf8');
  // Strip the shebang before prepending the server bootstrap: a `#!` on any line
  // but the first is a fatal SyntaxError for `node -` (stdin) and `node file.js`.
  // Derive the bootstrap origin from the Host header so tunnel/LAN clients get
  // a routable address instead of the listen address (0.0.0.0).
  const body = source.replace(/^#![^\n]*\n?/, '');
  return new Response(`process.env.AGENT_PLATFORM_SERVER=${JSON.stringify(requestOrigin(request))};\n${body}`, {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
  });
}
