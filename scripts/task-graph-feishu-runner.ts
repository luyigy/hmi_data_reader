import { prisma } from '../src/lib/prisma';
import { relayTaskGraphReplies } from '../src/lib/task-graph/run-reply-relay';

let stopped = false;
process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });
(async () => {
  while (!stopped) {
    await relayTaskGraphReplies();
    if (!stopped) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
})().catch((error) => { console.error('[TaskGraphReplies]', error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
