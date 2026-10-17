import { prisma } from '../src/lib/prisma';
import { listSpecPackages } from '../src/lib/task-graph/spec-package';
import { proposeIssueSpec } from '../src/lib/task-graph/propose-spec';

function option(name: string) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const parentTaskId = option('parent-task-id');
  const createdBy = option('agent') || 'local-agent';
  const versionText = option('version');
  const version = versionText ? Number(versionText) : undefined;
  const packageRepository = option('spec-repository');
  const packageManifest = option('spec-package');
  if (!parentTaskId || !packageRepository || !packageManifest || option('file') || (version !== undefined && (!Number.isInteger(version) || version < 1))) {
    throw new Error('Usage: npm run task-graph:propose -- --parent-task-id=<id> --spec-repository=<repo> --spec-package=docs/specs/<slug>/spec-package.json [--version=<n>] [--agent=<name>]；不再接受手写 --file 路线');
  }
  const { commit } = await listSpecPackages(packageRepository);
  const proposal = await proposeIssueSpec({ repository: packageRepository, commit, manifestPath: packageManifest, parentTaskId, version, createdBy });
  console.log(JSON.stringify({ proposalId: proposal.id, parentTaskId, version: proposal.version,
    cardMessageId: proposal.cardMessageId, status: proposal.status }));
}

main().then(() => prisma.$disconnect()).catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await prisma.$disconnect();
  process.exitCode = 1;
});
