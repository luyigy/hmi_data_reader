import { readFile } from 'node:fs/promises';
import {
  validateWorkflowDocuments,
  GitRefReader,
  WorkingTreeReader,
  WorkflowDocumentValidationError,
  type WorkflowValidationIssue,
} from '../src/lib/scheduled-jobs/workflow-validator';

// Printed next to genuine document validation failures in --hook-batch mode.
// The Git reference-transaction hook only rejects a commit when this marker is
// present, so validator runtime crashes (missing node/ts-node, broken contract
// loading) degrade to a warning instead of blocking every commit.
export const DOCUMENT_VALIDATION_FAILED_MARKER = 'WORKFLOW_DOCUMENT_VALIDATION_FAILED';

const hookBatchMode = process.argv[2] === '--hook-batch';
const preflightIndex = process.argv.indexOf('--preflight');
const preflightMode = preflightIndex !== -1;
const jsonMode = process.argv.includes('--json');
const jsonIssues = (issues: WorkflowValidationIssue[]) => issues.map((issue) => ({
  ...issue,
  expected: issue.expected ?? null,
  actual: issue.actual ?? null,
}));

const printWarnings = (results: Awaited<ReturnType<typeof validateWorkflowDocuments>>) => {
  for (const result of results) {
    for (const issue of result.issues.filter(({ severity }) => severity === 'warning')) {
      console.warn(`WARN ${result.filePath} [${issue.code}] [${issue.location}] ${issue.message}\n${issue.template}`);
    }
  }
};

async function main() {
  if (hookBatchMode) {
    const batchPath = process.argv[3];
    if (!batchPath) throw new Error('usage: validate-workflow-documents --hook-batch <batch-file>');
    const groups = new Map<string, {
      contractRef: string;
      ref: string;
      contractPath: string;
      filePaths: string[];
    }>();
    for (const line of (await readFile(batchPath, 'utf8')).split('\n').filter(Boolean)) {
      const [contractRef, ref, contractPath, filePath, ...extra] = line.split('\t');
      if (!contractRef || !ref || !contractPath || !filePath || extra.length) {
        throw new Error('invalid workflow hook batch');
      }
      const key = JSON.stringify([contractRef, ref, contractPath]);
      const group = groups.get(key) ?? { contractRef, ref, contractPath, filePaths: [] };
      group.filePaths.push(filePath);
      groups.set(key, group);
    }
    let documentFailure = false;
    let runtimeFailure = false;
    for (const group of Array.from(groups.values())) {
      try {
        printWarnings(await validateWorkflowDocuments({ cwd: process.cwd(), ...group }));
      } catch (error) {
        if (error instanceof WorkflowDocumentValidationError) {
          documentFailure = true;
          console.error(`${DOCUMENT_VALIDATION_FAILED_MARKER}\n${error.message}`);
        } else {
          runtimeFailure = true;
          console.error(
            `[workflow-guard] validator runtime failure, commit allowed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    if (documentFailure) process.exitCode = 1;
    else if (runtimeFailure) process.exitCode = 2;
    return;
  }

  if (preflightMode) {
    const filePath = process.argv[preflightIndex + 1];
    if (!filePath || filePath.startsWith('--')) {
      throw new Error('usage: npm run workflow:validate -- --preflight <PLAN-or-HANDOVER> [--json]');
    }
    try {
      const signal = new AbortController().signal;
      const [result] = await validateWorkflowDocuments({
        cwd: process.cwd(),
        ref: 'HEAD',
        filePaths: [filePath],
        signal,
        reader: new WorkingTreeReader(process.cwd(), 'HEAD', signal),
        contractReader: new GitRefReader(process.cwd(), 'HEAD', signal),
      });
      if (jsonMode) console.log(JSON.stringify(jsonIssues(result.issues)));
      else {
        console.log(`PASS ${result.filePath} action=${result.action}`);
        printWarnings([result]);
      }
    } catch (error) {
      if (jsonMode && error instanceof WorkflowDocumentValidationError) {
        console.log(JSON.stringify(jsonIssues(error.issues)));
      } else if (error instanceof WorkflowDocumentValidationError) {
        console.error(`FAIL ${filePath}: ${error.message}`);
        for (const issue of error.issues) console.error(`\n${issue.template}`);
      } else {
        throw error;
      }
      process.exitCode = 1;
    }
    return;
  }

  const [ref, ...filePaths] = process.argv.slice(2);
  if (!ref || !filePaths.length) {
    throw new Error('usage: npm run workflow:validate -- <git-ref> <PLAN-or-HANDOVER> [...]');
  }

  let failed = false;
  for (const filePath of filePaths) {
    try {
      const [result] = await validateWorkflowDocuments({ cwd: process.cwd(), ref, filePaths: [filePath] });
      console.log(`PASS ${result.filePath} action=${result.action}`);
      printWarnings([result]);
    } catch (error) {
      failed = true;
      console.error(`FAIL ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  // In hook-batch mode only genuine document validation failures (exit 1 with
  // the marker) may reject a commit; anything else is a validator runtime
  // failure and must not block unrelated commits.
  process.exitCode = hookBatchMode ? 2 : 1;
});
