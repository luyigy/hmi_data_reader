import { loadEnvConfig } from '@next/env';
import { readFile } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma';
import { registerInputCandidate } from '../src/lib/task-graph/input-candidates';
import { redactSensitiveText } from '../src/lib/redact-sensitive';
loadEnvConfig(process.cwd());
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--receipt') throw new Error('用法：--receipt <JSON文件>；登记已获授权的固定候选，下一 claim 生效，不直接恢复或汇合');
  console.log(JSON.stringify(await registerInputCandidate(JSON.parse(await readFile(args[1], 'utf8')))));
}
main().catch(error => { console.error(redactSensitiveText(error instanceof Error ? error.message : String(error))); process.exitCode = 1; }).finally(() => prisma.$disconnect());
