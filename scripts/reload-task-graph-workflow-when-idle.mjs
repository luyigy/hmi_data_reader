import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const require = createRequire(import.meta.url);
require('@next/env').loadEnvConfig(process.cwd());
const db = new PrismaClient();
const handover = process.argv.includes('--handover');
const services = handover
  ? ['agent-platform-feishu.service', 'agent-platform-scheduled-jobs.service']
  : ['agent-platform-task-graph.service', 'agent-platform-feishu.service', 'agent-platform-task-graph-feishu.service'];
const deadline = Date.now() + 20 * 60_000;
try {
  while (Date.now() < deadline) {
    const active = await db.taskRun.count({ where: { status: { in: ['running', 'waiting_for_input'] } } });
    const activeJobs = handover ? await db.scheduledJobRun.count({ where: { status: 'running' } }) : 0;
    const activeDeliveries = handover
      ? await db.liveRoomDelivery.count({ where: { deliveryStatus: { in: ['pending', 'running'] } } }) : 0;
    if (active === 0 && activeJobs === 0 && activeDeliveries === 0) {
      const previousPids = services.map((service) => execFileSync('systemctl', ['--user', 'show', service, '--property=MainPID', '--value'], { encoding: 'utf8' }).trim());
      execFileSync('systemctl', ['--user', 'restart', ...services], { stdio: 'inherit' });
      for (const [index, service] of services.entries()) {
        execFileSync('systemctl', ['--user', 'is-active', service], { stdio: 'inherit' });
        const pid = execFileSync('systemctl', ['--user', 'show', service, '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
        if (!/^[1-9]\d*$/.test(pid) || pid === previousPids[index]) {
          throw new Error(`Runtime reload failed: ${service} MainPID did not change to a running process (${previousPids[index]} -> ${pid})`);
        }
      }
      console.log('Workflow runtimes reloaded while no TaskRun was running.');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (Date.now() >= deadline) throw new Error('Runtime reload deferred: TaskRuns, jobs or deliveries remained active for 20 minutes');
} finally { await db.$disconnect(); }
