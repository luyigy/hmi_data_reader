import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { claimFeishuMessage } from '../src/lib/feishu-message-dedup';

const seen = new Set<string>();
let cleanupBefore: Date | undefined;
const db = {
  feishuProcessedMessage: {
    async create({ data }: { data: { messageId: string } }) {
      if (seen.has(data.messageId)) {
        throw new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      seen.add(data.messageId);
    },
    async deleteMany({ where }: { where: { createdAt: { lt: Date } } }) {
      cleanupBefore = where.createdAt.lt;
    },
  },
};

async function main() {
  const now = new Date('2026-07-29T15:00:00.000Z');
  assert.equal(await claimFeishuMessage(db, 'om_08a216', now), true);
  assert.equal(await claimFeishuMessage(db, 'om_08a216', now), false);
  assert.equal(cleanupBefore?.toISOString(), '2026-07-22T15:00:00.000Z');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
