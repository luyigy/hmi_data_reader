import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxEnvironmentRemovals } from '../src/lib/harness/sandbox-env';
import { runSandboxedGraphCheck } from '../src/lib/task-graph/check-environment';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'declared-runtime-'));
  const previous = process.env.TASK_GRAPH_VALIDATION_ROOT; process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'runtimes');
  const repository = path.join(root, 'repo'); await fs.mkdir(path.join(repository, '.agent-platform'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  const declarationPath = path.join(repository, '.agent-platform/runtime.json');
  const commit = async (declaration: unknown) => { await fs.writeFile(declarationPath, JSON.stringify(declaration)); git('add', '.'); git('commit', '-m', 'runtime contract'); };
  await commit({ version: 1, browser: { module: { path: 'missing-playwright', sha256: '0'.repeat(64) }, executable: { path: 'missing-browser', sha256: '0'.repeat(64) } } });
  try {
    await assert.rejects(runSandboxedGraphCheck(['sh', '-c', 'echo command-ran'], repository), error => error instanceof Error && error.name === 'RuntimePreparationError' && /缺少 Playwright/.test(error.message), 'Missing required capability must be found before the approved check executes');
  const inherited = { NODE_ENV: process.env.NODE_ENV, AP_TASK_SANDBOX: '1', PLAYWRIGHT_MODULE: '/host/module', PLAYWRIGHT_CHROMIUM_EXECUTABLE: '/host/chrome' };
  assert.deepEqual(sandboxEnvironmentRemovals(inherited), ['NODE_ENV', 'PLAYWRIGHT_MODULE', 'PLAYWRIGHT_CHROMIUM_EXECUTABLE']);
  const declared = { ...inherited, AP_GRAPH_RUNTIME_IDENTITY: 'a'.repeat(64), AP_GRAPH_BROWSER_MODULE: '/host/module', AP_GRAPH_BROWSER_EXECUTABLE: '/host/chrome' };
  assert.deepEqual(sandboxEnvironmentRemovals(declared), ['NODE_ENV']);
  assert.deepEqual(sandboxEnvironmentRemovals({ ...declared, PLAYWRIGHT_MODULE: '/other/module' }), ['NODE_ENV', 'PLAYWRIGHT_MODULE']);
    const { prepareDeclaredRuntime, RuntimePreparationError } = await import('../src/lib/task-graph/runtime-preflight');
    const { runtimeResourceDigest, runtimeDeclaration } = await import('../src/lib/task-graph/runtime-contract');
    const output = path.join(root, 'output'); await fs.mkdir(output);
    const module = await fs.realpath('/data1/code/agent-platform-v2/node_modules/playwright');
    const core = await fs.realpath('/data1/code/agent-platform-v2/node_modules/playwright-core');
    const executable = await fs.realpath('/opt/google/chrome/chrome');
    const browser = { module: { path: module, sha256: await runtimeResourceDigest(module) }, executable: { path: executable, sha256: await runtimeResourceDigest(executable) } };
    await commit({ version: 1, browser });
    await assert.rejects(prepareDeclaredRuntime({ workspace: repository, approvedReadOnlyRoots: [], outputDirectory: output }), error => error instanceof RuntimePreparationError && error.kind === 'invalid' && /已批准目录/.test(error.message));
    const prepared = await prepareDeclaredRuntime({ workspace: repository, approvedReadOnlyRoots: [module, core, path.dirname(executable)], outputDirectory: output });
    assert.match(prepared.env.AP_GRAPH_RUNTIME_IDENTITY, /^[a-f0-9]{64}$/);
    const receipt = JSON.parse(await fs.readFile(path.join(output, `runtime-preflight-${prepared.identity}.json`), 'utf8'));
    assert.match(receipt.browserVersion, /^\d+\./, 'Real installed browser launches inside Bubblewrap and reads a local page');
    const checked = await runSandboxedGraphCheck(['node', '-e', 'if(!process.env.PLAYWRIGHT_MODULE||!process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE)throw Error("declared browser env lost");console.log("declared check environment ready")'], repository, {}, [module, core, path.dirname(executable)]);
    assert.match(checked.stdout, /declared check environment ready/);
    const weights = path.join(root, 'first-output/ocr-models'); await fs.mkdir(weights, { recursive: true }); await fs.writeFile(path.join(weights, 'weights.bin'), 'approved OCR weights');
    const ocr = { weights: { kind: 'output', eventId: 'original-output-event', relativePath: 'ocr-models', sha256: await runtimeResourceDigest(weights) }, requiredFiles: ['weights.bin'] };
    await commit({ version: 1, ocr });
    const firstArtifact = { eventId: 'original-output-event', directory: path.dirname(weights), originalDirectory: path.dirname(weights), archived: false };
    const first = await prepareDeclaredRuntime({ workspace: repository, approvedReadOnlyRoots: [firstArtifact.directory], outputDirectory: output, priorArtifacts: [firstArtifact] });
    const archived = path.join(root, 'verified-archive/files/original-attempt'); await fs.mkdir(path.dirname(archived), { recursive: true }); await fs.rename(firstArtifact.directory, archived);
    const next = await prepareDeclaredRuntime({ workspace: repository, approvedReadOnlyRoots: [archived], outputDirectory: output, priorArtifacts: [{ ...firstArtifact, directory: archived, archived: true }] });
    assert.equal(next.identity, first.identity, 'Archiving a verified resource must not change its content/event identity');
    assert.equal(next.env.AP_GRAPH_OCR_MODEL_DIR, path.join(archived, 'ocr-models'));
    await fs.writeFile(declarationPath, '{uncommitted');
    assert.equal((await runtimeDeclaration(repository))?.declaration.version, 1, 'Read committed declaration, not unapproved edits');
    await fs.unlink(declarationPath);
    await assert.rejects(runtimeDeclaration(repository), /缺失/, 'Removing a tracked declaration cannot disable preflight');
    await fs.writeFile(declarationPath, JSON.stringify({ version: 1, ocr }));
    await fs.writeFile(path.join(archived, 'ocr-models/weights.bin'), 'tampered');
    await assert.rejects(prepareDeclaredRuntime({ workspace: repository, approvedReadOnlyRoots: [archived], outputDirectory: output, priorArtifacts: [{ ...firstArtifact, directory: archived, archived: true }] }), error => error instanceof RuntimePreparationError && error.kind === 'invalid');
    console.log(`Declared runtime: real Chromium ${receipt.browserVersion} launched in Bubblewrap; missing/out-of-scope/corrupt resources refused before check; OCR identity survives archive relocation`);
  } finally {
    if (previous === undefined) delete process.env.TASK_GRAPH_VALIDATION_ROOT; else process.env.TASK_GRAPH_VALIDATION_ROOT = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
