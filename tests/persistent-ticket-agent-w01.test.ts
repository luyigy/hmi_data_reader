import assert from 'node:assert/strict';
import { buildRunReplyCard } from '../src/lib/task-graph/run-reply-card';
import { verifyNativeWorkspace } from './persistent-ticket-agent-w01-native';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createWorktree, removeWorktree, listWorktrees } from '../src/lib/git-worktree';
import { workspacePath, workspaceIdentity, workspaceSegment } from '../src/lib/workspace-layout';
import { inspectWorkspace, inventoryWorkspaces, operateWorkspace, type ReferenceCheck } from '../src/lib/workspace-operations';
import { ensureJobWorktree, inspectJobWorktree, ensureIntegrationRef, integrateJobWorktree, commitJobWorktree, cleanupIntegratedJobWorktree } from '../src/lib/task-graph/worktree';
import { ensureReadOnlyWorkspace } from '../src/lib/task-graph/readonly-workspace';
import { prepareExtraRepositories } from '../src/lib/task-graph/extra-repositories';
import { prepareSandboxEnvironment } from '../src/lib/sandbox-manager/environment';
import { renderBubblewrap } from '../src/lib/sandbox-manager/bubblewrap';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function repository(directory: string) {
  await fs.mkdir(directory, { recursive: true });
  git(directory, 'init', '-b', 'main');
  git(directory, 'config', 'user.name', 'W01 Test');
  git(directory, 'config', 'user.email', 'w01@localhost');
  await fs.writeFile(path.join(directory, 'file.txt'), 'preserve\n');
  git(directory, 'add', '.'); git(directory, 'commit', '-m', 'base');
  return directory;
}
async function run() {
  const root = await fs.mkdtemp(path.join(process.env.AP_GRAPH_OUTPUT_DIR || os.tmpdir(), 'w01-'));
  const oldRoot = process.env.AP_WORKSPACE_ROOT;
  try {
    const repo = await repository(path.join(root, 'repo'));
    const central = path.join(root, 'central');
    process.env.AP_WORKSPACE_ROOT = central;
    const first = await createWorktree(repo, 'same-name');
    assert.ok(first.startsWith(central + path.sep), `New development workspace must use central root: ${first}`);
    assert.equal(await createWorktree(repo, 'same-name'), first, 'Stable work identity reuses checkout');
    for (const malicious of ['../escape', 'a/b', 'a\\b', '..', '', 'bad\nname']) {
      await assert.rejects(() => createWorktree(repo, malicious));
    }
    assert.notEqual(await createWorktree(repo, 'a:b'), await createWorktree(repo, 'a?b'), 'Normalized labels must retain distinct identities');
    const otherRepo = await repository(path.join(root, 'other', 'repo'));
    assert.notEqual(await createWorktree(otherRepo, 'same-name'), first, 'Same project basename cannot collide');
    const baseline = await createWorktree(repo, 'baseline', undefined, 'baselines');
    assert.ok(baseline.includes('/baselines/'));
    assert.equal(await createWorktree(first, 'same-name'), first, 'Linked checkouts share project identity');
    const base = git(repo, 'rev-parse', 'HEAD');
    const request = { repoPath: repo, runId: 'route-1', jobId: 'same-ticket', baseRef: 'refs/heads/main', baseCommit: base };
    const job = await ensureJobWorktree(request);
    assert.ok(job.path.includes('/routes/'));
    assert.notEqual((await ensureJobWorktree({ ...request, runId: 'route-2' })).path, job.path);
    assert.equal((await ensureJobWorktree(request)).path, job.path);
    await assert.rejects(() => ensureJobWorktree({ ...request, jobId: '../../bad' }));
    const nativeJob = await ensureJobWorktree({ ...request, jobId: 'native-session' });
    const nativeEvidence = await verifyNativeWorkspace(nativeJob.path, first, root);
    console.log(JSON.stringify({ event: 'w01-native-protocol-fixture', evidence: nativeEvidence }));
    assert.ok((await inspectWorkspace(repo, nativeJob.path)).reasons.length, 'A persisted native Session remains at its original path');
    const reader = await ensureReadOnlyWorkspace(repo, base, 'reader-1');
    assert.ok(reader.includes('/readonly/'));
    assert.equal(await ensureReadOnlyWorkspace(repo, base, 'reader-1'), reader);
    assert.notEqual(await ensureReadOnlyWorkspace(repo, base, 'reader-2'), reader, 'Readers from different Tickets cannot share a new checkout');
    await assert.rejects(() => prepareExtraRepositories([{ repository: reader, access: 'read' }]));
    const extra = await prepareExtraRepositories([{ repository: otherRepo, access: 'read' }]);
    assert.deepEqual(extra.details.map(item => item.repository), [otherRepo]);
    assert.ok(!extra.paths.includes(central));
    const plan = prepareSandboxEnvironment({ command: '/usr/bin/true', commandArgs: [], cwd: job.path, workspaceRoot: job.path,
      sandboxMode: 'workspace-write', strictReadOnlyRoots: true, readOnlyPaths: [], env: { NODE_ENV: process.env.NODE_ENV || 'test', PATH: process.env.PATH } });
    const rendered = renderBubblewrap(plan);
    const mounts = rendered.args.flatMap((value, index, all) => ['--bind', '--ro-bind'].includes(value) ? [all[index + 1]] : []);
    assert.ok(mounts.includes(job.path));
    for (const denied of [central, first, reader, path.dirname(job.path)]) assert.ok(!mounts.includes(denied), `Sandbox must not mount ${denied}`);
    await fs.writeFile(path.join(job.path, 'ticket.txt'), 'candidate\n');
    const candidate = await commitJobWorktree({ ...request, message: 'candidate' });
    const integration = await ensureIntegrationRef(request);
    const merged = await integrateJobWorktree({ ...request, integrationRef: integration.ref, expectedIntegrationCommit: integration.commit,
      verify: async directory => assert.equal(await fs.readFile(path.join(directory, 'ticket.txt'), 'utf8'), 'candidate\n') });
    assert.equal(merged.commit, candidate);
    await assert.rejects(() => cleanupIntegratedJobWorktree({ ...request, integrationRef: integration.ref }), /release proof/);
    assert.ok((await listWorktrees(repo)).some(tree => tree.path === job.path));
    await cleanupIntegratedJobWorktree({ ...request, integrationRef: integration.ref, assertReleased: async () => {} });
    assert.equal(git(repo, 'rev-parse', job.branch), candidate, 'Cleanup keeps the branch and commits');
    await cleanupIntegratedJobWorktree({ ...request, integrationRef: integration.ref, assertReleased: async () => {} });

    // Explicit old roots and registry-bound paths remain authoritative after root configuration changes.
    const old = await ensureJobWorktree({ ...request, jobId: 'old', worktreeRoot: path.join(root, 'explicit-old') });
    await fs.writeFile(path.join(old.path, 'untracked'), 'retain scene');
    process.env.AP_WORKSPACE_ROOT = path.join(root, 'changed-root');
    assert.equal((await ensureJobWorktree({ ...request, jobId: 'old' })).path, old.path);
    assert.equal((await inspectJobWorktree({ ...request, jobId: 'old', worktreePath: old.path })).path, old.path);
    await assert.rejects(() => ensureJobWorktree({ ...request, jobId: 'missing-ledger', worktreePath: path.join(root, 'missing-recorded-path') }), /Recorded workspace/);
    await assert.rejects(() => ensureJobWorktree({ ...request, jobId: 'old', worktreePath: first }), /Recorded workspace/);
    assert.equal(await fs.readFile(path.join(old.path, 'untracked'), 'utf8'), 'retain scene');
    assert.equal(await createWorktree(repo, 'same-name'), first);
    await assert.rejects(() => prepareExtraRepositories([{ repository: reader, access: 'read' }]));
    await assert.rejects(() => prepareExtraRepositories([{ repository: first, access: 'write' }]));
    assert.equal(await ensureReadOnlyWorkspace(repo, base, 'reader-1'), reader, 'Read-only workspace must survive root changes');
    process.env.AP_WORKSPACE_ROOT = central;
    const legacy = path.join(path.dirname(repo), '.agent-platform-task-graph-worktrees', workspaceIdentity(repo), workspaceIdentity('legacy-route'), 'jobs', workspaceIdentity('legacy-ticket'));
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    git(repo, 'worktree', 'add', '-b', `task-graph/jobs/${workspaceIdentity('legacy-route')}/${workspaceIdentity('legacy-ticket')}`, legacy, base);
    assert.equal((await ensureJobWorktree({ ...request, runId: 'legacy-route', jobId: 'legacy-ticket' })).path, legacy);
    const legacyDev = path.join(repo, '.worktrees', 'legacy-dev');
    git(repo, 'worktree', 'add', '-b', 'legacy-development', legacyDev, base);
    assert.equal(await createWorktree(repo, 'legacy-dev'), legacyDev);
    const legacyRead = path.join(path.dirname(repo), '.agent-platform-conversation-worktrees', createHash('sha256').update(`${repo}:${base}`).digest('hex'));
    await fs.mkdir(path.dirname(legacyRead), { recursive: true });
    git(repo, 'worktree', 'add', '--detach', legacyRead, base);
    assert.equal(await ensureReadOnlyWorkspace(repo, base, 'old-reader'), legacyRead);

    const conflict = await createWorktree(repo, 'conflict');
    await fs.writeFile(path.join(conflict, 'file.txt'), 'conflicting branch\n');
    git(conflict, 'add', 'file.txt'); git(conflict, 'commit', '-m', 'conflicting branch');
    const conflictMain = await createWorktree(repo, 'conflict-main');
    await fs.writeFile(path.join(conflictMain, 'file.txt'), 'other branch\n');
    git(conflictMain, 'add', 'file.txt'); git(conflictMain, 'commit', '-m', 'other branch');
    assert.throws(() => git(conflict, 'merge', git(conflictMain, 'rev-parse', 'HEAD')));
    const conflicted = await inspectWorkspace(repo, conflict);
    assert.ok(conflicted.reasons.some(reason => reason.includes('MERGE_HEAD')));
    assert.ok(git(conflict, 'diff', '--name-only', '--diff-filter=U').includes('file.txt'));
    const released: ReferenceCheck = async () => ({ kind: 'released', savedRef: 'refs/heads/main' });
    const card = buildRunReplyCard({ id: 'workspace-card', status: 'running', summary: null, error: null, participants: [],
      graphWorkspace: { repository: repo, executionId: 'old-ticket', branch: old.branch, path: old.path } }, []);
    const cardText = JSON.stringify(card);
    assert.ok(cardText.includes(old.path) && cardText.includes(old.branch) && cardText.includes('old-ticket'));
    const initial = await inspectWorkspace(repo, first, released);
    assert.deepEqual(initial.reasons, []);
    assert.ok(initial.fingerprint);
    const fingerprint = initial.fingerprint;
    const destination = await workspacePath(repo, 'development', ['moved']);
    let approvals = 0;
    const move: Parameters<typeof operateWorkspace>[0] = { repository: repo, directory: first, operation: { kind: 'move', destination }, expectedFingerprint: fingerprint,
      checkReferences: released, authorize: async () => { approvals++; } };
    await assert.rejects(() => operateWorkspace({ ...move, checkReferences: async () => ({ kind: 'retain', reasons: ['Active native Session'] }) }), /Session/);
    await assert.rejects(() => operateWorkspace({ ...move, checkReferences: async () => ({ kind: 'retain', reasons: ['Unknown Writer'] }) }), /Writer/);
    await assert.rejects(() => operateWorkspace({ ...move, authorize: async () => { throw new Error('No authorization'); } }), /authorization/);
    assert.ok((await inventoryWorkspaces(repo)).every(item => item.reasons.length), 'Uncertain references are never silently recyclable');
    await fs.writeFile(path.join(first, 'untracked'), 'do not delete');
    assert.ok((await inspectWorkspace(repo, first, released)).reasons.some(reason => reason.includes('Uncommitted')));
    await assert.rejects(() => operateWorkspace(move), /retained/);
    await fs.unlink(path.join(first, 'untracked'));
    await fs.writeFile(path.join(first, 'file.txt'), 'modified\n');
    await assert.rejects(() => operateWorkspace(move), /retained/);
    git(first, 'restore', 'file.txt');
    git(first, 'config', 'core.excludesFile', path.join(root, 'ignore'));
    await fs.writeFile(path.join(root, 'ignore'), 'ignored\n');
    await fs.writeFile(path.join(first, 'ignored'), 'preserve ignored');
    await assert.rejects(() => operateWorkspace(move), /Ignored/);
    await fs.unlink(path.join(first, 'ignored'));
    await fs.writeFile(path.join(first, 'unique'), 'unique commit');
    git(first, 'add', '.'); git(first, 'commit', '-m', 'unique');
    await assert.rejects(() => operateWorkspace(move), /not saved/);
    git(repo, 'merge', '--ff-only', git(first, 'rev-parse', 'HEAD'));
    const saved = await inspectWorkspace(repo, first, released);
    assert.ok(saved.fingerprint);
    const savedMove = { ...move, expectedFingerprint: saved.fingerprint };
    git(repo, 'worktree', 'lock', first, '--reason', 'active operator');
    await assert.rejects(() => operateWorkspace(savedMove), /locked/);
    git(repo, 'worktree', 'unlock', first);
    let referenceReads = 0;
    await assert.rejects(() => operateWorkspace({ ...savedMove, checkReferences: async () => ++referenceReads === 1
      ? released(first) : { kind: 'retain', reasons: ['Session acquired during operation'] } }), /changed/);
    assert.ok((await listWorktrees(repo)).some(tree => tree.path === first));
    await assert.rejects(() => operateWorkspace({ ...savedMove, operation: { kind: 'move', destination: path.join(root, 'outside-project') } }), /central project/);
    await operateWorkspace(savedMove);
    await operateWorkspace(savedMove); // Reconcile an interrupted response using the destination registration.
    assert.equal(git(destination, 'rev-parse', 'HEAD'), saved.head);
    assert.equal(git(destination, 'symbolic-ref', '--short', 'HEAD'), saved.branch);
    assert.equal(await fs.readFile(path.join(destination, 'file.txt'), 'utf8'), 'preserve\n');
    assert.equal(await createWorktree(repo, 'same-name'), destination);
    assert.ok(approvals >= 2);
    const removal: Parameters<typeof operateWorkspace>[0] = { ...savedMove, directory: destination, operation: { kind: 'remove' } };
    await operateWorkspace(removal);
    await operateWorkspace(removal);
    assert.equal(git(repo, 'rev-parse', `refs/heads/${saved.branch}`), saved.head);
    await assert.rejects(() => removeWorktree(repo, old.path), /proof|evidence/);
    assert.equal(await fs.readFile(path.join(old.path, 'untracked'), 'utf8'), 'retain scene');
    const symbolicTarget = await workspacePath(repo, 'baselines', ['symlinked']);
    await fs.symlink(path.join(root, 'other'), symbolicTarget);
    await assert.rejects(() => createWorktree(repo, 'symlinked', undefined, 'baselines'), /symbolic/);
    console.log(`W01 behavior passed: centralized creation, legacy reuse, isolation, safe move/remove and retention. Fixture: ${root}`);
  } finally {
    if (!process.env.AP_GRAPH_OUTPUT_DIR) await fs.rm(root, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.AP_WORKSPACE_ROOT; else process.env.AP_WORKSPACE_ROOT = oldRoot;
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
