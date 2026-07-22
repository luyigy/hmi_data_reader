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
const deferred = new Map([
  ['Task', new Set(['currentTaskSessionId'])],
  ['LiveRoom', new Set(['currentSpeakerMemberId'])],
  ['LiveRoomMessage', new Set(['replyToMessageId'])],
]);
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

function sqliteTables() {
  return sqlite.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations'
    ORDER BY name
  `).all().map(({ name }) => name);
}

function importOrder(tables) {
  const remaining = new Set(tables);
  const ordered = [];
  while (remaining.size) {
    const ready = [...remaining].filter((table) => sqlite.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all()
      .every((fk) => deferred.get(table)?.has(fk.from) || !remaining.has(fk.table)));
    if (!ready.length) throw new Error(`Unresolved foreign-key cycle: ${[...remaining].join(', ')}`);
    for (const table of ready) {
      remaining.delete(table);
      ordered.push(table);
    }
  }
  return ordered;
}

function convert(value, dataType) {
  if (value == null) return null;
  if (dataType === 'boolean') return Boolean(value);
  if (dataType.startsWith('timestamp')) {
    return new Date(typeof value === 'number' ? value : `${value.replace(' ', 'T')}Z`);
  }
  return value;
}

async function insertBatch(table, columns, types, rows) {
  const values = [];
  const tuples = rows.map((row) => `(${columns.map((column) => {
    values.push(convert(row[column], types.get(column)));
    return `$${values.length}`;
  }).join(', ')})`);
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES ${tuples.join(', ')}`,
    ...values,
  );
}

async function restoreDeferred(table, column) {
  const rows = sqlite.prepare(
    `SELECT "id", ${quote(column)} AS value FROM ${quote(table)} WHERE ${quote(column)} IS NOT NULL`,
  ).all();
  for (let offset = 0; offset < rows.length; offset += 250) {
    const values = [];
    const tuples = rows.slice(offset, offset + 250).map((row) => {
      values.push(row.id, row.value);
      return `($${values.length - 1}, $${values.length})`;
    });
    await prisma.$executeRawUnsafe(
      `UPDATE ${quote(table)} AS target SET ${quote(column)} = source.value
       FROM (VALUES ${tuples.join(', ')}) AS source(id, value) WHERE target."id" = source.id`,
      ...values,
    );
  }
}

try {
  const targetColumns = await prisma.$queryRawUnsafe(`
    SELECT table_name AS table, column_name AS column, data_type AS type
    FROM information_schema.columns WHERE table_schema = 'public'
  `);
  const targetTables = new Set(targetColumns.map(({ table }) => table).filter((table) => table !== '_prisma_migrations'));
  const tables = sqliteTables();
  const missing = tables.filter((table) => !targetTables.has(table));
  if (missing.length) throw new Error(`Target schema is missing tables: ${missing.join(', ')}`);

  for (const table of tables) {
    const [{ count }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM ${quote(table)}`);
    if (count) throw new Error(`Target table is not empty: ${table} (${count} rows)`);
  }

  for (const table of importOrder(tables)) {
    const sourceColumns = sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all().map(({ name }) => name);
    const typeMap = new Map(targetColumns.filter((item) => item.table === table).map((item) => [item.column, item.type]));
    const missingColumns = sourceColumns.filter((column) => !typeMap.has(column));
    if (missingColumns.length) throw new Error(`${table}: target is missing columns ${missingColumns.join(', ')}`);
    const deferredColumns = deferred.get(table) ?? new Set();
    const columns = sourceColumns.filter((column) => !deferredColumns.has(column));
    const total = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get().count;
    for (let offset = 0; offset < total; offset += 250) {
      const rows = sqlite.prepare(`SELECT * FROM ${quote(table)} LIMIT 250 OFFSET ?`).all(offset);
      await insertBatch(table, columns, typeMap, rows);
    }
    console.log(`${table}: ${total}`);
  }

  for (const [table, columns] of deferred) {
    for (const column of columns) await restoreDeferred(table, column);
  }
  console.log('SQLite → PostgreSQL migration completed. Run npm run db:verify:migration.');
} finally {
  sqlite.close();
  await prisma.$disconnect();
}
