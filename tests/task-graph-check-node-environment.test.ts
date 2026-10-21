import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runSandboxedGraphCheck } from '../src/lib/task-graph/check-environment';
import { graphDependencyPaths } from '../src/lib/task-graph/dependency-paths';

async function main() {
  const root = await fs.mkdtemp(path.join(process.env.AP_GRAPH_OUTPUT_DIR || os.tmpdir(), 'node-check-'));
  const repo = path.join(root, 'repo');
  const job = path.join(root, 'job');
  await fs.mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Check fixture'); git('config', 'user.email', 'check@localhost');
  await fs.mkdir(path.join(repo, 'src'));
  await fs.mkdir(path.join(repo, 'tests'));
  await fs.writeFile(path.join(repo, '.gitignore'), 'node_modules\n');
  await fs.writeFile(path.join(repo, 'src/value.ts'), 'export const value: number = 42;\n');
  await fs.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({ compilerOptions: { esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler', baseUrl: '.', paths: { '@/*': ['./src/*'] } }, 'ts-node': { compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2022' } } }));
  const dependencies = graphDependencyPaths(process.cwd()).find(directory => path.basename(directory) === 'node_modules');
  assert.ok(dependencies, 'Host-installed source dependencies must be available');
  await fs.symlink(dependencies, path.join(repo, 'node_modules'));
  await fs.writeFile(path.join(repo, 'tests/approved.ts'), `import assert from 'node:assert/strict';\nimport { value } from '@/value';\nimport { writeFileSync } from 'node:fs';\nassert.equal(value,42);\nassert.throws(() => writeFileSync(require.resolve('ts-node/package.json'),'forbidden'), /EROFS|EACCES/);\nconsole.log('approved-preload-and-alias-ready');\n`);
  git('add', '.'); git('commit', '-m', 'fixture'); git('worktree', 'add', '-b', 'job', job);
  assert.equal(await fs.lstat(path.join(job, 'node_modules')).then(() => true, () => false), false, 'A new checkout has no dependency installation');
  const previous = { nodePath: process.env.NODE_PATH, compiler: process.env.TS_NODE_COMPILER_OPTIONS, baseUrl: process.env.TS_NODE_BASEURL, validation: process.env.TASK_GRAPH_VALIDATION_ROOT };
  try {
    delete process.env.NODE_PATH; delete process.env.TS_NODE_COMPILER_OPTIONS; delete process.env.TS_NODE_BASEURL;
    process.env.TASK_GRAPH_VALIDATION_ROOT = path.join(root, 'validation');
    const result = await runSandboxedGraphCheck(['node', '-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', 'tests/approved.ts'], job);
    assert.match(result.stdout, /approved-preload-and-alias-ready/);
    assert.equal(await fs.readFile(path.join(dependencies, 'ts-node/package.json'), 'utf8').then(text => JSON.parse(text).name), 'ts-node');
    console.log('Actual sandboxed check loads primary readonly dependencies without inherited Node or ts-node configuration');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries({ NODE_PATH: previous.nodePath, TS_NODE_COMPILER_OPTIONS: previous.compiler, TS_NODE_BASEURL: previous.baseUrl, TASK_GRAPH_VALIDATION_ROOT: previous.validation })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
