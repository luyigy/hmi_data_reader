import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareDeclaredRuntime, assertRuntimeResourcesUnchanged } from '../src/lib/task-graph/runtime-preflight';
import { runtimeResourceDigest } from '../src/lib/task-graph/runtime-contract';

async function main() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'ap-skill-runtime-'));
  const workspace = path.join(root, 'job'), bundle = path.join(root, 'host-skill'), config = path.join(root, 'skills'), output = path.join(root, 'output');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe', encoding: 'utf8' }).trim();
  try {
    for (const dir of [workspace, bundle, config, output, path.join(workspace, '.agent-platform'), path.join(bundle, 'references'), path.join(bundle, 'playbooks'), path.join(bundle, 'scripts')]) await fs.mkdir(dir, { recursive: true });
    await fs.symlink(bundle, path.join(config, 'poteto-mode'));
    await fs.writeFile(path.join(bundle, 'SKILL.md'), 'Skill entry');
    await fs.writeFile(path.join(bundle, 'references/codex-tools.md'), 'Codex mapping');
    await fs.writeFile(path.join(bundle, 'playbooks/feature.md'), 'Feature workflow');
    const secret = path.join(root, 'private-host-file'); await fs.writeFile(secret, 'not authorized');
    await fs.writeFile(path.join(bundle, 'scripts/check-playbooks.mjs'), `import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');for(const file of ['SKILL.md','references/codex-tools.md','playbooks/feature.md'])fs.readFileSync(path.join(root,file));if(fs.existsSync(${JSON.stringify(secret)}))throw Error('host file visible');try{fs.writeFileSync(path.join(root,'forbidden'),'x');throw Error('skill package writable')}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')throw e}console.log('complete package verified; host private file hidden');`);
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    const manifest = () => ({ version: 1, skills: [{ id: 'poteto-mode', package: { path: bundle, sha256: '' }, requiredFiles: ['SKILL.md', 'references/codex-tools.md', 'playbooks/feature.md'], checkScript: 'scripts/check-playbooks.mjs' }] });
    const commit = async () => { const declaration = manifest(); declaration.skills[0].package.sha256 = await runtimeResourceDigest(bundle); await fs.writeFile(path.join(workspace, '.agent-platform/runtime.json'), JSON.stringify(declaration)); git('add', '.'); git('commit', '--allow-empty', '-m', 'skill declaration'); };
    await commit();
    const prepare = (roots: string[]) => prepareDeclaredRuntime({ workspace, approvedReadOnlyRoots: roots, outputDirectory: output, strictReadOnlyRoots: true });
    const prepared = await prepare([config, bundle]);
    assert.ok(prepared.identity);
    assert.match(JSON.stringify(prepared.receipt), /complete package verified/);
    assert.ok(prepared.readOnlyPaths.includes(bundle));
    assert.equal((await fs.readdir(bundle)).includes('forbidden'), false);
    await assert.rejects(prepare([config]), /批准|授权/);
    await fs.writeFile(path.join(bundle, 'playbooks/feature.md'), 'changed after pin');
    await assert.rejects(assertRuntimeResourcesUnchanged(prepared.verifiedResources), /预检后改变/);
    await assert.rejects(prepare([config, bundle]), /SHA256|摘要/);
    await fs.unlink(path.join(bundle, 'references/codex-tools.md')); await commit();
    await assert.rejects(prepare([config, bundle]), /必需文件|预检失败/);
    await fs.symlink(secret, path.join(bundle, 'escape'));
    await assert.rejects(runtimeResourceDigest(bundle), /链接/);
    if (process.env.AP_TEST_POTETO_PACKAGE && process.env.AP_TEST_POTETO_ADAPTATION) {
      const installed = await fs.realpath(process.env.AP_TEST_POTETO_PACKAGE);
      await fs.mkdir(path.join(workspace, '.agents/playbooks'), { recursive: true });
      await fs.copyFile(process.env.AP_TEST_POTETO_ADAPTATION, path.join(workspace, '.agents/playbooks/ap-task-graph.md'));
      await fs.writeFile(path.join(workspace, '.agent-platform/runtime.json'), JSON.stringify({ version: 1, skills: [{
        id: 'poteto-mode', package: { path: installed, sha256: await runtimeResourceDigest(installed) },
        requiredFiles: ['SKILL.md', 'references/codex-tools.md', ...['feature', 'bug-fix', 'refactoring', 'session-pickup'].map(name => `playbooks/${name}.md`)], checkScript: 'scripts/check-playbooks.mjs',
      }] }));
      git('add', '.'); git('commit', '-m', 'installed poteto package');
      const actual = await prepare([installed]);
      assert.match(JSON.stringify(actual.receipt), /Every project playbook matches/);
      console.log('Installed poteto-mode, Codex mapping, four playbooks and actual project adaptation verified in Bubblewrap');
    }
    console.log('Complete skill package verified in strict Bubblewrap; unauthorized targets, missing mapping, changed digests and link escapes are rejected');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
