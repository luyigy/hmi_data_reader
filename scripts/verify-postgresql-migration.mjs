import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PrismaClient } from '@prisma/client';

const sourcePath = resolve(process.argv[2] ?? 'prisma/dev.db');
const targetUrl = process.env.DATABASE_URL ?? '';
if (!existsSync(sourcePath)) throw new Error(`SQLite source not found: ${sourcePath}`);
if (!/^postgres(?:ql)?:\/\//.test(targetUrl)) throw new Error('DATABASE_URL must use PostgreSQL');

const sqlite = new DatabaseSync(sourcePath, { readOnly: true });
const prisma = new PrismaClient();
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const normalize = (value, type) => {
  if (value == null) return null;
  if (type === 'boolean') return Boolean(value);
  if (type.startsWith('timestamp')) {
    return new Date(value instanceof Date || typeof value === 'number' ? value : `${value.replace(' ', 'T')}Z`).toISOString();
  }
  return typeof value === 'bigint' ? value.toString() : value;
};

try {
  const metadata = await prisma.$queryRawUnsafe(`
    SELECT table_name AS table, column_name AS column, data_type AS type, ordinal_position AS position
    FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position
  `);
  const tables = sqlite.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations'
    ORDER BY name
  `).all().map(({ name }) => name);
  let failed = false;

  for (const table of tables) {
    const columns = sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all();
    const types = new Map(metadata.filter((item) => item.table === table).map((item) => [item.column, item.type]));
    const order = columns.filter(({ pk }) => pk).sort((a, b) => a.pk - b.pk).map(({ name }) => quote(name));
    const orderBy = order.length ? order.join(', ') : columns.map(({ name }) => quote(name)).join(', ');
    const sourceRows = sqlite.prepare(`SELECT * FROM ${quote(table)} ORDER BY ${orderBy}`).all();
    const targetRows = await prisma.$queryRawUnsafe(`SELECT * FROM ${quote(table)} ORDER BY ${orderBy}`);
    const digest = (rows) => {
      const hash = createHash('sha256');
      for (const row of rows) hash.update(`${JSON.stringify(columns.map(({ name }) => normalize(row[name], types.get(name))))}\n`);
      return hash.digest('hex');
    };
    const sourceHash = digest(sourceRows);
    const targetHash = digest(targetRows);
    const ok = sourceRows.length === targetRows.length && sourceHash === targetHash;
    failed ||= !ok;
    console.log(`${ok ? 'OK' : 'FAIL'} ${table}: rows=${sourceRows.length}, sha256=${sourceHash}`);

    for (const fk of sqlite.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all()) {
      const [{ count }] = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count FROM ${quote(table)} child
         LEFT JOIN ${quote(fk.table)} parent ON child.${quote(fk.from)} = parent.${quote(fk.to)}
         WHERE child.${quote(fk.from)} IS NOT NULL AND parent.${quote(fk.to)} IS NULL`,
      );
      if (count) {
        failed = true;
        console.log(`FAIL ${table}.${fk.from}: ${count} orphan rows`);
      }
    }
  }

  if (failed) throw new Error('Migration verification failed');
  console.log('All table counts, row hashes, and foreign keys match.');
} finally {
  sqlite.close();
  await prisma.$disconnect();
}
