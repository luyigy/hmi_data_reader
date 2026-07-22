import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  sqlitePragmas: Promise<void> | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

export const ensureSqlitePragmas = () => {
  if (!globalForPrisma.sqlitePragmas) {
    globalForPrisma.sqlitePragmas = prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000')
      .then(() => prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL'))
      .then(() => undefined)
      .catch((error) => {
        globalForPrisma.sqlitePragmas = undefined;
        throw error;
      });
  }
  return globalForPrisma.sqlitePragmas;
};

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

void ensureSqlitePragmas().catch((error) => console.error('Failed to configure SQLite:', error));
