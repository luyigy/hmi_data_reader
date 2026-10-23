import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { runtimeResourceDigest } from './runtime-contract';
import type { PostgresService } from './service-contract';

// Positional arguments carry paths; no caller text is evaluated as shell code.
const START_POSTGRES = `set -eu
"$1/bin/initdb" -D "$2/db" -U postgres --auth-local=reject --auth-host=scram-sha-256 --pwfile="$2/password" --no-locale -E UTF8
rm "$2/password"
exec "$1/bin/postgres" -D "$2/db" -h 127.0.0.1 -p "$3" -k ''`;

export async function preparePostgresService(service: PostgresService, data: string, port: number, signal: AbortSignal) {
  // Snapshot the complete bundle (bin/lib/share), then verify the bytes actually mounted.
  // runtimeResourceDigest rejects links, special files and unbounded resources.
  if (await runtimeResourceDigest(service.resource.path) !== service.resource.sha256) throw new Error('PostgreSQL resource SHA256 mismatch');
  signal.throwIfAborted();
  const resource = path.join(path.dirname(data), `${service.key}.resource`);
  await cp(service.resource.path, resource, { recursive: true, mode: constants.COPYFILE_FICLONE });
  if (await runtimeResourceDigest(resource) !== service.resource.sha256) throw new Error('PostgreSQL resource changed while copying');
  for (const filename of ['bin/initdb', 'bin/postgres']) {
    if (!(await stat(path.join(resource, filename))).isFile()) throw new Error('PostgreSQL bundle missing ' + filename);
  }
  for (const dirname of ['lib', 'share/postgresql']) {
    if (!(await stat(path.join(resource, dirname))).isDirectory()) throw new Error('PostgreSQL bundle missing ' + dirname);
  }
  signal.throwIfAborted();
  await mkdir(data, { mode: 0o700 });
  const password = randomBytes(24).toString('hex');
  await writeFile(path.join(data, 'password'), password, { mode: 0o600 });
  const url = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres?connect_timeout=1&socket_timeout=1&connection_limit=1`;
  const client = new PrismaClient({ datasources: { db: { url } } });
  return {
    command: '/bin/sh', argv: ['-c', START_POSTGRES, 'postgres-service', resource, data, String(port)],
    readOnlyPaths: [resource, '/etc/passwd', '/etc/nsswitch.conf'],
    identity: { runtime: service.runtime, resource: { ...service.resource }, entry: path.join(resource, 'bin/postgres') },
    url,
    healthy: async () => {
      signal.throwIfAborted();
      const rows = await client.$queryRaw<{ directory: string; address: string }[]>`SELECT current_setting('data_directory') AS directory, host(inet_server_addr()) AS address`;
      signal.throwIfAborted();
      return rows.length === 1 && rows[0].directory === path.join(data, 'db') && rows[0].address === '127.0.0.1';
    },
    close: () => client.$disconnect(),
  };
}
