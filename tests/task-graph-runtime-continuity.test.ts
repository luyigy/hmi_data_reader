import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { wrapWithBubblewrap } from '../src/lib/harness/bubblewrap';
import { prepareDeclaredRuntime } from '../src/lib/task-graph/runtime-preflight';
import { runtimeDeclaration, runtimeResourceDigest } from '../src/lib/task-graph/runtime-contract';

async function main() {
  const scratch = await mkdtemp(path.join(tmpdir(), 'runtime-continuity-'));
  try {
    const repo = path.join(scratch, 'repo'); await mkdir(path.join(repo, '.agent-platform'), { recursive: true });
    const modulePath = await realpath(path.dirname(require.resolve('playwright/package.json')));
    const corePath = await realpath(path.dirname(require.resolve('playwright-core/package.json')));
    const executable = await realpath(process.env.AP_RUNTIME_TEST_CHROMIUM_EXECUTABLE || '/opt/google/chrome/chrome');
    const approvedReadOnlyRoots = [modulePath, corePath, path.dirname(executable)];
    const declaration = { version: 1, browser: { module: { path: modulePath, sha256: await runtimeResourceDigest(modulePath) }, executable: { path: executable, sha256: await runtimeResourceDigest(executable) } } };
    await writeFile(path.join(repo, '.agent-platform/runtime.json'), JSON.stringify(declaration));
    await writeFile(path.join(repo, 'source.txt'), 'readonly source');
    await writeFile(path.join(repo, '.gitignore'), '.venv/\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test'); git('add', '.'); git('commit', '-m', 'Pinned runtime fixture');
    const sourceDeclaration = await runtimeDeclaration(repo); assert(sourceDeclaration);
    execFileSync('python3', ['-m', 'venv', '--without-pip', path.join(repo, '.venv')]);
    const reader = path.join(scratch, 'second-python-project'); await mkdir(reader);
    execFileSync('git', ['init', '-b', 'main'], { cwd: reader });
    execFileSync('python3', ['-m', 'venv', '--without-pip', path.join(reader, '.venv')]);
    const out = path.join(scratch, 'implementation-output'); await mkdir(out);
    const implementation = await prepareDeclaredRuntime({ workspace: repo, approvedReadOnlyRoots, outputDirectory: out });
    assert(implementation.identity);
    const review = path.join(scratch, 'non-git-review'); await mkdir(review);
    const reviewOut = path.join(scratch, 'review-output'); await mkdir(reviewOut);
    const acceptance = await prepareDeclaredRuntime({ workspace: review, approvedReadOnlyRoots: [...approvedReadOnlyRoots, repo, reader], outputDirectory: reviewOut,
      sourceDeclaration, resourceWorkspace: repo });
    assert.equal(acceptance.identity, implementation.identity, 'Non-Git acceptance must consume the same pinned source runtime, rather than silently dropping browser declaration');
    const derived = path.join(scratch, 'derived-worktree'); git('worktree', 'add', '--detach', derived, sourceDeclaration.commit);
    const derivedOut = path.join(scratch, 'derived-output'); await mkdir(derivedOut);
    const descendant = await prepareDeclaredRuntime({ workspace: derived, approvedReadOnlyRoots, outputDirectory: derivedOut, sourceDeclaration, resourceWorkspace: derived });
    assert.equal(descendant.identity, implementation.identity, 'Derived worktree uses identical resource bytes and identity');
    const script = 'const fs=require("fs"),p=process.argv[1],out=process.argv[2];for(const f of [p+"/source.txt",process.env.PLAYWRIGHT_MODULE+"/package.json"]){try{fs.writeFileSync(f,"forbidden");throw Error("writable input")}catch(e){if(e.code!=="EROFS"&&e.code!=="EACCES")throw e}}fs.writeFileSync(out+"/receipt.json","writable output");fs.writeFileSync("/tmp/private-runtime-test","private tmp");console.log(process.env.TMPDIR)';
    const env = { ...process.env, ...acceptance.env, AP_TASK_SANDBOX: '1', AP_SANDBOX_MODEL_ACCESS: '0', HOME: reviewOut, AP_GRAPH_OUTPUT_DIR: reviewOut, AP_GRAPH_OUTPUT_BINDINGS_JSON: JSON.stringify([{ source: reviewOut, target: reviewOut, readOnly: false }]) };
    const sandbox = wrapWithBubblewrap({ command: process.execPath, commandArgs: ['-e', script, repo, reviewOut], cwd: review, workspaceRoot: review, sandboxMode: 'read-only', readOnlyPaths: [...approvedReadOnlyRoots, repo], env });
    assert.equal(execFileSync(sandbox.command, sandbox.args, { encoding: 'utf8', env }).trim(), '/tmp', 'Browser temp uses private short sandbox path');
    const snap = path.join(repo, 'snap-wrapper'); await writeFile(snap, '#!/bin/sh\nexec /snap/bin/chromium "$@"\n', { mode: 0o755 });
    const invalid = { ...declaration, browser: { ...declaration.browser, executable: { path: snap, sha256: await runtimeResourceDigest(snap) } } };
    await writeFile(path.join(repo, '.agent-platform/runtime.json'), JSON.stringify(invalid)); git('add', '.'); git('commit', '-m', 'Explicit bad Snap declaration');
    await assert.rejects(prepareDeclaredRuntime({ workspace: repo, approvedReadOnlyRoots, outputDirectory: out }), /浏览器启动预检失败/, 'Explicit bad browser never falls back to the working host browser');
    const absent = { ...declaration, browser: { ...declaration.browser, executable: { path: path.join(repo, 'missing-chrome'), sha256: 'a'.repeat(64) } } };
    await writeFile(path.join(repo, '.agent-platform/runtime.json'), JSON.stringify(absent)); git('add', '.'); git('commit', '-m', 'Explicit missing browser');
    await assert.rejects(prepareDeclaredRuntime({ workspace: repo, approvedReadOnlyRoots, outputDirectory: out }), /缺少 Chromium/, 'Missing declared browser cannot silently use the installed host browser');
    await writeFile(path.join(repo, '.agent-platform/runtime.json'), JSON.stringify(declaration)); git('add', '.'); git('commit', '-m', 'Restore valid declaration');
    await writeFile(path.join(repo, '.agent-platform/runtime.json'), '{invalid');
    await assert.rejects(prepareDeclaredRuntime({ workspace: repo, approvedReadOnlyRoots, outputDirectory: out }), /未提交改动/, 'Uncommitted explicit configuration is rejected');
    console.log(JSON.stringify({ identity: implementation.identity, acceptanceIdentity: acceptance.identity, browser: implementation.receipt, derivedIdentity: descendant.identity, scenario: 'real browser implementation, non-Git acceptance with two distinct project Python environments, and derived worktree; readonly inputs, writable output and private tmp; explicit Snap and config mutation rejected' }));
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
