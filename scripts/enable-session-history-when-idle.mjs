// Run from the deployed repository. No conversation or native history is deleted here.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// No timeout: long-running tasks must not silently cancel an authorized deployment.
export async function waitForHistoryIdle(snapshot, report, pause = sleep) {
  const isIdle = counts => counts.runs === 0 && counts.jobs === 0 && counts.deliveries === 0;
  while (true) {
    const counts = await snapshot();
    await report(counts);
    if (isIdle(counts)) {
      await pause(3000);
      const checked = await snapshot();
      if (isIdle(checked)) return;
      await report(checked);
    }
    await pause(5000);
  }
}

async function main() {
  createRequire(import.meta.url)('@next/env').loadEnvConfig(process.cwd());
  const db = new PrismaClient();
  const root = process.env.AP_SESSION_HISTORY_STATE_ROOT || path.join(homedir(), '.agent-platform/session-history');
  const services = ['agent-platform-dev.service', 'agent-platform-feishu.service', 'agent-platform-scheduled-jobs.service', 'agent-platform-task-graph.service', 'agent-platform-task-graph-feishu.service'];
  const save = async (name, value) => {
    await writeFile(path.join(root, name + '.tmp'), JSON.stringify(value), { mode: 0o600 });
    await rename(path.join(root, name + '.tmp'), path.join(root, name));
  };
  const status = (state, counts) => save('activation.json', { state, counts, updatedAt: Date.now() });
  const snapshot = async () => {
    const [runs, jobs, deliveries] = await Promise.all([
      db.taskRun.count({ where: { status: { in: ['pending', 'running', 'waiting_for_input'] } } }),
      db.scheduledJobRun.count({ where: { status: 'running' } }),
      db.liveRoomDelivery.count({ where: { deliveryStatus: 'running' } }),
    ]);
    return { runs, jobs, deliveries };
  };
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await unlink(path.join(root, 'enabled.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    console.log('Waiting for idle tasks; activation remains scheduled without a time limit.');
    await waitForHistoryIdle(snapshot, counts => status('waiting', counts));
    await status('reloading');
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
    await save('enabled.json', marker);
    await status('ready');
    console.log('Session history cleanup enabled after all five services reloaded. Native histories untouched.');
  } catch (error) {
    await status('failed');
    throw error;
  } finally { await db.$disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
