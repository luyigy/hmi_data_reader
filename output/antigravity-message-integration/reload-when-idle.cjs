// One-shot rollout: never restart while recorded executions or deliveries are active.
const { createRequire } = require('node:module');
const requireRepo = createRequire(process.cwd() + '/package.json');
requireRepo('@next/env').loadEnvConfig(process.cwd());
const { PrismaClient } = requireRepo('@prisma/client');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const db = new PrismaClient();
const unit = 'agent-platform-feishu.service';
const receipt = 'output/antigravity-message-integration/reload.json';
const pid = () => execFileSync('systemctl', ['--user', 'show', unit, '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim();
const initialPid = pid();
const record = (status, extra = {}) => fs.writeFileSync(receipt, JSON.stringify({ status, at: new Date().toISOString(), initialPid, ...extra }, null, 2));
(async () => {
  let idle = 0;
  record('waiting_for_idle');
  for (let attempt = 0; attempt < 240; attempt++) {
    if (pid() !== initialPid) { record('service_already_restarted'); return; }
    const [runs, deliveries] = await Promise.all([
      db.taskRunParticipant.count({ where: { status: 'running' } }),
      db.liveRoomDelivery.count({ where: { deliveryStatus: { in: ['pending', 'running', 'processing'] } } }),
    ]);
    idle = runs === 0 && deliveries === 0 ? idle + 1 : 0;
    if (idle >= 2) {
      execFileSync('systemctl', ['--user', 'restart', unit], { timeout: 45000 });
      await new Promise(resolve => setTimeout(resolve, 10000));
      const state = execFileSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' }).trim();
      record('restarted', { state, currentPid: pid() });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
  record('timed_out_without_restart');
})().catch(error => { record('failed', { error: String(error) }); process.exitCode = 1; })
  .finally(() => db.$disconnect());
