import { prisma } from '../src/lib/prisma';
import { auditGraphConversationInputs } from '../src/lib/task-graph/conversation-input-audit';

async function main() {
  const args = process.argv.slice(2);
  const runId = args.find(arg => arg.startsWith('--run='))?.slice(6);
  if (!runId || args.length !== 1) throw new Error('Usage: audit-graph-conversation-inputs --run=<id> (read-only)');
  const rows = await auditGraphConversationInputs(runId);
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.disposition] = (counts[row.disposition] || 0) + 1;
  console.log(JSON.stringify({ at: new Date().toISOString(), runId, counts, rows }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
