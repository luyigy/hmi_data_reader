import { Prisma } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 7 * DAY_MS;
let lastCleanupAt = 0;

type FeishuProcessedMessageStore = {
  feishuProcessedMessage: {
    create(args: { data: { messageId: string } }): Promise<unknown>;
    deleteMany(args: { where: { createdAt: { lt: Date } } }): Promise<unknown>;
  };
};

export async function claimFeishuMessage(
  db: FeishuProcessedMessageStore,
  messageId: string,
  now = new Date(),
) {
  try {
    await db.feishuProcessedMessage.create({ data: { messageId } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
    throw error;
  }

  if (now.getTime() - lastCleanupAt >= DAY_MS) {
    lastCleanupAt = now.getTime();
    void db.feishuProcessedMessage.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - RETENTION_MS) } },
    }).catch((error) => {
      lastCleanupAt = 0;
      console.error('[FeishuRuntime] failed to clean processed messages', error);
    });
  }

  return true;
}
