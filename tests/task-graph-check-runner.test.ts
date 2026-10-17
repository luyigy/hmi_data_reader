import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { runGraphCheck } from '../src/lib/task-graph/check-runner';

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'graph-check-'));
  try {
    await assert.rejects(runGraphCheck([process.execPath, '-e', 'console.error("required preview button missing"); process.exit(7)'], root),
      /exit 7[\s\S]*required preview button missing/);
    const heartbeat = path.join(root, 'heartbeat');
    const childCode = 'const fs=require("node:fs"); process.on("SIGTERM",()=>{}); setInterval(()=>fs.writeFileSync(process.env.HEARTBEAT, String(Date.now())),10);';
    const parentCode = `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'}); setInterval(()=>{},1000);`;
    await assert.rejects(runGraphCheck([process.execPath, '-e', parentCode], root, { HEARTBEAT: heartbeat }, 500), /timed out after 500ms/);
    const before = await readFile(heartbeat, 'utf8');
    await wait(100);
    assert.equal(await readFile(heartbeat, 'utf8'), before, 'Timeout must stop descendants as well as the shell');
    const result = await runGraphCheck([process.execPath, '-e', 'console.log(process.env.CHECK_VALUE)'], root, { CHECK_VALUE: 'isolated-check' });
    assert.match(result.stdout, /isolated-check/);
    console.log('Graph checks preserve failures, distinguish timeout and stop descendant processes');
  } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
