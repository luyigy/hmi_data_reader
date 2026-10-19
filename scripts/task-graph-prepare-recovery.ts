import { loadEnvConfig } from '@next/env';
import { readFile } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma';
import { inspectPreparationBinding, registerPlatformPreparation } from '../src/lib/task-graph/preparation-recovery';
import { redactSensitiveText } from '../src/lib/redact-sensitive';
loadEnvConfig(process.cwd());
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--receipt') {
    console.log(JSON.stringify(await registerPlatformPreparation(JSON.parse(await readFile(args[1], 'utf8')))));
    return;
  }
  if (args.length === 6 && args[0] === '--run-id' && args[2] === '--node-key' && args[4] === '--remediation' &&
      (args[5] === 'upstream_binding' || args[5] === 'missing_capability')) {
    console.log(JSON.stringify({ bindingHash: await inspectPreparationBinding(args[1], args[3], args[5]),
      readiness: 'local_operator_attested', note: '只读绑定；登记前须实际完成准备并提供授权、变更说明和校验日志。' }));
    return;
  }
  throw new Error('用法：--run-id <Run> --node-key <Slice> --remediation <upstream_binding|missing_capability>（只读）；--receipt <JSON文件>（登记运维准备证明，不直接恢复）');
}
main().catch(error => { console.error(redactSensitiveText(error instanceof Error ? error.message : String(error))); process.exitCode = 1; }).finally(() => prisma.$disconnect());
