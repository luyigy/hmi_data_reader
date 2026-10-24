import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

execFileSync(process.execPath, ['scripts/check-stage-execution-wire.mjs'], { stdio: 'inherit' });

// Every table mutation is confined to a fresh schema; never push a schema into public.
// Explicit configuration wins; a repository .env is only an optional host-side fallback for sandboxed runs.
const fromFile = !process.env.DATABASE_URL && existsSync('.env') ? readFileSync('.env', 'utf8').match(/^DATABASE_URL=["']?([^\r\n"']+)/m)?.[1] : undefined;
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
execFileSync(process.execPath, ['scripts/check-task-admission.mjs'], { env, stdio: 'inherit' });
const registeredSuites = ['task-graph-recovery-lock-order', 'task-graph-review-lock-order', 'task-graph-review-publication', 'task-graph-postgres-runtime', 'task-graph-card-status', 'task-graph-agent-owned-quality', 'task-graph-runtime-reuse', 'task-graph-skill-claim', 'task-graph-approved-continuation', 'task-graph-admission', 'task-graph-condition-recheck', 'task-graph-natural-blockers', 'task-graph-upstream-capacity', 'project-capabilities-browse', 'task-graph-check-node-environment', 'persistent-ticket-agent-t3', 'task-graph-git-digest', 'persistent-ticket-agent-t2', 'persistent-ticket-agent-t1', 'persistent-ticket-agent-t0', 'project-capabilities-scope-change', 'task-graph-stage-authority', 'task-graph-sandbox-manager', 'task-graph-skill-runtime', 'task-graph-continuation-eligibility', 'task-graph-p0-timeout', 'task-graph-p0-reservation', 'project-capabilities-c02', 'project-capabilities-live', 'project-capabilities-c01', 'task-graph-conversation-delivery', 'task-graph-interactive-conversation', 'task-graph-prepared-review', 'task-graph-runtime-pinning', 'task-graph-pending-review-repair', 'task-graph-preparation-recovery', 'task-graph-run-doctor', 'task-graph-process-lineage', 'task-graph-conflict-repair', 'task-graph-conflict-continuation', 'task-graph-integrated-restart', 'task-graph-environment-outcome', 'feishu-startup-task-cleanup', 'task-graph-review-platform-retry', 'task-graph-acceptance-resume', 'task-graph-restart-ancestry', 'task-graph-review-repair', 'task-graph-targeted-repair', 'task-graph-lifecycle-adapters', 'task-graph-card-closure', 'task-graph-writer-ownership', 'task-graph-restart-recovery', 'task-graph-review-restart', 'task-graph-progress-adoption', 'task-graph-auto-completion', 'task-graph-execution-progress', 'task-graph-result-recollection', 'task-graph-output-runtime', 'task-graph-output-lifecycle', 'task-graph-notification-recovery', 'task-graph-reply-summary', 'task-graph-route-summary', 'task-graph-repository-topic', 'task-graph-feishu-dm-relay', 'task-graph-parallel-workspaces', 'task-graph-extra-repositories', 'task-graph-extra-upstream-binding', 'task-graph-reclassification', 'task-graph-service-execution', 'task-graph-services', 'task-graph-upstream-inputs', 'task-graph-implementation-recovery', 'task-graph-validation-archive', 'task-graph-runtime-inputs', 'task-graph-continuation', 'acpx-interaction-events', 'task-graph-conversation-materials', 'task-graph-issue-adoption', 'task-graph-issue-execution', 'task-graph-issues', 'task-graph-issue-proposal', 'task-graph-sandbox', 'task-graph-conversation', 'task-graph-completed-workspaces', 'task-graph-worktree', 'task-graph-integration-retry', 'task-graph-review-workspaces', 'task-graph-check-runner', 'task-graph-feishu-relay', 'task-graph-retry', 'task-graph-snapshot', 'task-graph-db', 'task-graph-proposal', 'task-graph-proposal-delivery', 'task-graph-failure-summary', 'task-graph-prior-output-archive'];
// Service deployment smoke is explicit; the ordinary regression run does not start a web server.
const deploymentSuites = ['task-graph-p0-service', 'task-graph-native-topic-continuation'];
const requestedSuites = process.argv.slice(2);
if (requestedSuites.some(name => ![...registeredSuites, ...deploymentSuites].includes(name))) throw new Error('Unknown task graph test suite');
const suites = requestedSuites.length ? requestedSuites : registeredSuites;
const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'task-graph-test-workspaces-'));
env.AP_WORKSPACE_ROOT = workspaceRoot;
try {
  const [server] = await admin.$queryRaw`SELECT host(inet_server_addr()) AS address`;
  if (!['127.0.0.1', '::1'].includes(server?.address) && !localContainerOwnsServer(server?.address)) {
    throw new Error('Database server is neither local loopback nor a verified local container');
  }
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env, stdio: 'pipe' });
  for (const file of suites) {
    const suiteUrl = new URL(url);
    // Keep the publication regression sensitive to queries escaping its transaction.
    if (file === 'task-graph-review-publication') suiteUrl.searchParams.set('connection_limit', '1');
    execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', `tests/${file}.test.ts`], {
      env: { ...env, DATABASE_URL: suiteUrl.toString() }, stdio: 'inherit',
    });
  }
} finally {
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.$disconnect();
  rmSync(workspaceRoot, { recursive: true, force: true });
}
