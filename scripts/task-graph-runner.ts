import { prisma } from '../src/lib/prisma';
import { startTaskGraphCoordinator } from '../src/lib/task-graph/coordinator';

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());

startTaskGraphCoordinator(controller.signal)
  .then(() => prisma.$disconnect())
  .catch((error) => {
    console.error('[TaskGraph]', error);
    process.exitCode = 1;
  });
