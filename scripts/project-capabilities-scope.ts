import { migrateLegacyProjectScope } from '../src/lib/project-capabilities/legacy-scope';
import { prisma } from '../src/lib/prisma';
const value = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
async function main() {
  const executionId = value('execution-id');
  if (!executionId) throw new Error('Usage: project-capabilities:scope -- --execution-id=<id> [--apply --policy-hash=<preview hash>]');
  console.log(JSON.stringify(await migrateLegacyProjectScope({ executionId, apply: process.argv.includes('--apply'), expectedPolicyHash: value('policy-hash') }), null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
