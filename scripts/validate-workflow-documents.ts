import { validateWorkflowDocuments } from '../src/lib/scheduled-jobs/workflow-validator';

async function main() {
  const [ref, ...filePaths] = process.argv.slice(2);
  if (!ref || !filePaths.length) {
    throw new Error('usage: npm run workflow:validate -- <git-ref> <PLAN-or-HANDOVER> [...]');
  }

  let failed = false;
  for (const filePath of filePaths) {
    try {
      const [result] = await validateWorkflowDocuments({ cwd: process.cwd(), ref, filePaths: [filePath] });
      console.log(`PASS ${result.filePath} action=${result.action}`);
    } catch (error) {
      failed = true;
      console.error(`FAIL ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
