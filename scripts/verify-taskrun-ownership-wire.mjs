import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = 'src/lib/feishu-startup-task-cleanup.ts';
const testFile = 'tests/feishu-startup-task-cleanup.test.ts';
const source = readFileSync(path.join(root, sourceFile), 'utf8');
const guard = "if (!run || run.status !== 'running' || await graphOwnsRun(tx, run)) return;";
if (source.split(guard).length !== 2) throw new Error('Ownership guard changed; review the mutation before running it');
const evidenceRoot = path.join(root, 'output', 'gardening');
mkdirSync(evidenceRoot, { recursive: true });
const evidence = mkdtempSync(path.join(evidenceRoot, 'taskrun-ownership-'));
const scratch = mkdtempSync(path.join(tmpdir(), 'ap-ownership-wire-'));
let preserveScratch = false;
const hash = text => createHash('sha256').update(text).digest('hex');
const run = name => {
  const result = spawnSync(process.execPath, ['scripts/test-task-graph-postgres.mjs', 'feishu-startup-task-cleanup'], {
    cwd: scratch, encoding: 'utf8',
  });
  const log = `${result.stdout || ''}\n${result.stderr || ''}`;
  writeFileSync(path.join(evidence, `${name}.log`), log);
  if (result.error || result.signal || result.status === null) {
    preserveScratch = true;
    throw new Error(`${name} has no normal exit proof; preserve ${scratch} and inspect ${evidence}`);
  }
  return { status: result.status, log };
};
try {
  for (const directory of ['src', 'prisma']) cpSync(path.join(root, directory), path.join(scratch, directory), { recursive: true, filter: name => !/dev\.db/.test(name) });
  mkdirSync(path.join(scratch, 'tests')); mkdirSync(path.join(scratch, 'scripts'));
  for (const file of [testFile, 'scripts/test-task-graph-postgres.mjs', 'tsconfig.json']) cpSync(path.join(root, file), path.join(scratch, file));
  symlinkSync(path.join(root, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
  symlinkSync(path.join(root, '.env'), path.join(scratch, '.env'));
  writeFileSync(path.join(scratch, sourceFile), source.replace(guard, "if (!run || run.status !== 'running') return;"));
  const red = run('red');
  if (red.status === 0 || !/belongs to another live owner/.test(red.log) || !/'completed'/.test(red.log) || !/'running'/.test(red.log)) {
    throw new Error(`Mutation did not reproduce the expected ownership violation; inspect ${evidence}`);
  }
  writeFileSync(path.join(scratch, sourceFile), source);
  const green = run('green');
  if (green.status !== 0 || !/Feishu startup preserves graph writers/.test(green.log)) throw new Error(`Correct implementation failed; inspect ${evidence}`);
  const receipt = { wire: 'taskrun-owner', checkedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    source: { path: sourceFile, sha256: hash(source) }, test: { path: testFile, sha256: hash(readFileSync(path.join(root, testFile))) },
    mutation: 'Remove the graph ownership guard only, in a disposable copy',
    red: { exitCode: red.status, expectedMismatch: "graph-owned TaskRun: actual 'completed', expected 'running'", log: 'red.log' },
    green: { exitCode: green.status, log: 'green.log' },
    command: 'node scripts/verify-taskrun-ownership-wire.mjs',
    limits: 'Isolated PostgreSQL and mocked outbound delivery; no live service restart or business graph mutation' };
  writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(`VERIFIED taskrun-owner: old defect rejected, correct implementation passed. ${path.relative(root, evidence)}/receipt.json`);
} finally {
  if (!preserveScratch) rmSync(scratch, { recursive: true, force: true });
}
