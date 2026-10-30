// Run from the deployed repository. No conversation or native history is deleted here.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
const require = createRequire(import.meta.url);
require('@next/env').loadEnvConfig(process.cwd());
const db = new PrismaClient();
const root = process.env.AP_SESSION_HISTORY_STATE_ROOT || path.join(homedir(), '.agent-platform/session-history');
const services = ['agent-platform-dev.service', 'agent-platform-feishu.service', 'agent-platform-scheduled-jobs.service', 'agent-platform-task-graph.service', 'agent-platform-task-graph-feishu.service'];
const deadline = Date.now() + 20 * 60000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const idle = async () => {
  const [runs, jobs, deliveries] = await Promise.all([
    db.taskRun.count({ where: { status: { in: ['pending', 'running', 'waiting_for_input'] } } }),
    db.scheduledJobRun.count({ where: { status: 'running' } }),
    db.liveRoomDelivery.count({ where: { deliveryStatus: 'running' } }),
  ]);
  return runs === 0 && jobs === 0 && deliveries === 0;
};
try {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await unlink(path.join(root, 'enabled.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  let done = false;
  while (Date.now() < deadline) {
    if (!await idle()) { await sleep(5000); continue; }
    await sleep(3000);
    if (!await idle()) continue;
    const previous = services.map(service => execFileSync('systemctl', ['--user', 'show', service, '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim());
    execFileSync('systemctl', ['--user', 'restart', ...services], { stdio: 'inherit' });
    const pids = services.map((service, index) => {
      execFileSync('systemctl', ['--user', 'is-active', service], { stdio: 'inherit' });
      const pid = execFileSync('systemctl', ['--user', 'show', service, '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim();
      if (!/^[1-9]\d*$/.test(pid) || pid === previous[index]) throw new Error(`Service did not reload: ${service}`);
      return pid;
    });
    let healthy = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { healthy = (await fetch('http://127.0.0.1:3010/api/health', { signal: AbortSignal.timeout(2000) })).ok; } catch {}
      if (healthy) break;
      await sleep(1000);
    }
    if (!healthy) throw new Error('Web health check failed; cleanup remains disabled.');
    const marker = { version: 1, reloadedAt: new Date().toISOString(), services, pids,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
    await writeFile(path.join(root, 'enabled.json.tmp'), JSON.stringify(marker), { mode: 0o600 });
    await rename(path.join(root, 'enabled.json.tmp'), path.join(root, 'enabled.json'));
    console.log('Session history cleanup enabled after all five services reloaded. Native histories untouched.');
    done = true; break;
  }
  if (!done) throw new Error('Tasks remained active for 20 minutes. Cleanup remains disabled; rerun during idle time.');
} finally { await db.$disconnect(); }
