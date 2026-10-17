import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

// Every table mutation is confined to a fresh schema; never push a schema into public.
const fromFile = readFileSync('.env', 'utf8').match(/^DATABASE_URL=["']?([^\r\n"']+)/m)?.[1];
const url = new URL(process.env.DATABASE_URL || fromFile || '');
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Only a loopback PostgreSQL server may host the scratch schema');
const schema = `task_graph_test_${randomUUID().replaceAll('-', '')}`;
const admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
url.searchParams.set('schema', schema);
const env = { ...process.env, DATABASE_URL: url.toString(), TS_NODE_BASEURL: '.',
  TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: 'commonjs', moduleResolution: 'node' }) };
function localContainerOwnsServer(address) {
  const docker = (...argv) => execFileSync('docker', argv, { encoding: 'utf8' }).trim();
  const context = JSON.parse(docker('context', 'inspect'));
  if (!context[0]?.Endpoints?.docker?.Host?.startsWith('unix://')) return false;
  const ids = docker('ps', '--filter', `publish=${url.port || '5432'}`, '--format', '{{.ID}}').split('\n').filter(Boolean);
  return ids.some((id) => {
    const network = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings}}', id));
    const addresses = Object.values(network.Networks || {}).map((network) => network.IPAddress);
    const port = (network.Ports?.['5432/tcp'] || []).some((binding) => binding.HostPort === (url.port || '5432')
      && ['127.0.0.1', '::1'].includes(binding.HostIp));
    return addresses.includes(address) && port;
  });
}
try {
  const [server] = await admin.$queryRaw`SELECT host(inet_server_addr()) AS address`;
  if (!['127.0.0.1', '::1'].includes(server?.address) && !localContainerOwnsServer(server?.address)) {
    throw new Error('Database server is neither local loopback nor a verified local container');
  }
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env, stdio: 'pipe' });
  for (const file of ['task-graph-reclassification', 'task-graph-service-execution', 'task-graph-services', 'task-graph-upstream-inputs', 'task-graph-implementation-recovery', 'task-graph-validation-archive', 'task-graph-runtime-inputs', 'task-graph-continuation', 'acpx-interaction-events', 'task-graph-conversation-materials', 'task-graph-issue-adoption', 'task-graph-issue-execution', 'task-graph-issues', 'task-graph-issue-proposal', 'task-graph-sandbox', 'task-graph-conversation', 'task-graph-completed-workspaces', 'task-graph-worktree', 'task-graph-review-workspaces', 'task-graph-check-runner', 'task-graph-feishu-relay', 'task-graph-retry', 'task-graph-snapshot', 'task-graph-db', 'task-graph-proposal', 'task-graph-proposal-delivery']) {
    execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', `tests/${file}.test.ts`], { env, stdio: 'inherit' });
  }
} finally {
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.$disconnect();
}
