import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const source = await readFile(path.join(process.cwd(), 'scripts/agent-platform-runner.js'), 'utf8');
  return new Response(`process.env.AGENT_PLATFORM_SERVER=${JSON.stringify(new URL(request.url).origin)};\n${source}`, {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
  });
}
