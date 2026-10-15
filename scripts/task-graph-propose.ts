import { readFile } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma';
import { createGraphProposal } from '../src/lib/task-graph/proposals';
import type { GraphDefinition } from '../src/lib/task-graph/domain';

function option(name: string) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const parentTaskId = option('parent-task-id');
  const file = option('file');
  const createdBy = option('agent') || 'local-agent';
  const versionText = option('version');
  const version = versionText ? Number(versionText) : undefined;
  if (!parentTaskId || !file || (version !== undefined && (!Number.isInteger(version) || version < 1))) {
    throw new Error('Usage: npm run task-graph:propose -- --parent-task-id=<id> --file=<route.json> [--version=<n>] [--agent=<name>]');
  }
  const definition = JSON.parse(await readFile(file, 'utf8')) as GraphDefinition;
  const proposal = await createGraphProposal({ parentTaskId, version, definition, createdBy });
  console.log(JSON.stringify({ proposalId: proposal.id, parentTaskId, version: proposal.version,
    cardMessageId: proposal.cardMessageId, status: proposal.status }));
}

main().then(() => prisma.$disconnect()).catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await prisma.$disconnect();
  process.exitCode = 1;
});
