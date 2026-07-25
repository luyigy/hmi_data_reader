import { prisma } from '../src/lib/prisma';
import { startScheduledJobRunner } from '../src/lib/scheduled-jobs/runner';

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());

startScheduledJobRunner(prisma, controller.signal)
  .then(() => prisma.$disconnect())
  .catch((error) => {
    console.error('[ScheduledJobRunner]', error);
    process.exitCode = 1;
  });
