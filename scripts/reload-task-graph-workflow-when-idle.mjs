import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const require = createRequire(import.meta.url);
require('@next/env').loadEnvConfig(process.cwd());
const db = new PrismaClient();
const deadline = Date.now() + 20 * 60_000;
try {
  while (Date.now() < deadline) {
    const active = await db.taskRun.count({ where: { status: 'running' } });
    if (active === 0) {
      execFileSync('systemctl', ['--user', 'restart', 'agent-platform-task-graph.service', 'agent-platform-feishu.service'], { stdio: 'inherit' });
      execFileSync('systemctl', ['--user', 'is-active', 'agent-platform-task-graph.service', 'agent-platform-feishu.service'], { stdio: 'inherit' });
      console.log('Workflow runtimes reloaded while no TaskRun was running.');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (Date.now() >= deadline) throw new Error('Runtime reload deferred: TaskRuns remained active for 20 minutes');
} finally { await db.$disconnect(); }
