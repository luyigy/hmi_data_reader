import { relayGraphOverviews } from '../src/lib/task-graph/overview';
import { relayPendingTurnCards } from '../src/lib/feishu-turn-card';
import { relayGraphNotifications } from '../src/lib/task-graph/notifications';
import { prisma } from '../src/lib/prisma';
import { relayTaskGraphReplies } from '../src/lib/task-graph/run-reply-relay';
import { PROGRESS_CARD_MIN_MS } from '../src/lib/acpx/harness-events';

let stopped = false;
process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });
(async () => {
  while (!stopped) {
    await relayPendingTurnCards();
    await relayGraphNotifications();
    await relayTaskGraphReplies();
    await relayGraphOverviews();
    if (!stopped) await new Promise((resolve) => setTimeout(resolve, PROGRESS_CARD_MIN_MS));
  }
})().catch((error) => { console.error('[TaskGraphReplies]', error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
