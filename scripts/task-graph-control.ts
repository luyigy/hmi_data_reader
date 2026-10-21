import { loadEnvConfig } from '@next/env';
import { prisma } from '../src/lib/prisma';
import { setGraphRunPaused } from '../src/lib/task-graph/run-control';
import { observeExecutionWriter } from '../src/lib/task-graph/phase-worker';

loadEnvConfig(process.cwd());

async function main() {
  const options = new Map<string, string>();
  for (const argument of process.argv.slice(2)) {
    const match = /^--(run-id|action|request-id|actor|reason)=(.+)$/.exec(argument);
    if (!match || options.has(match[1])) throw new Error('Use --run-id=... --action=pause|resume --request-id=... --actor=... --reason=...');
    options.set(match[1], match[2]);
  }
  const runId = options.get('run-id'), action = options.get('action'), requestId = options.get('request-id'), actorId = options.get('actor'), reason = options.get('reason');
  if (!runId || !requestId || !actorId || !reason || !['pause', 'resume'].includes(action || '')) throw new Error('Explicit run, action, request, actor and reason are required');
  const event = await setGraphRunPaused({ runId, paused: action === 'pause', requestId, actorId, reason });
  const run = await prisma.taskGraphRun.findUniqueOrThrow({ where: { id: runId }, include: { nodes: { include: { executions: true } } } });
  const writers = await Promise.all(run.nodes.flatMap(node => node.executions.map(async job => ({ node: node.key, execution: job.key,
    proof: await observeExecutionWriter(job) }))));
  console.log(JSON.stringify({ runId, status: run.status, eventId: event.id, writers,
    note: action === 'pause' ? 'Dispatch paused. The Coordinator stops owned processes; alive/unknown is not exit proof.' : 'Explicit user pause released; original permissions, writer fences and retry limits still apply.' }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
