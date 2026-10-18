import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { outputDeclaration } from '../harness/output-bindings';
import { graphGit } from './git-command';
import { validationRuntimeDirectory } from './acceptance-runtime';

const within = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

async function directory(target: string) {
  const parent = path.dirname(target);
  if (parent !== target) await directory(parent);
  try { await fs.mkdir(target, { mode: 0o700 }); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  if (!(await fs.lstat(target)).isDirectory() || await fs.realpath(target) !== target) throw new Error(`Output directory is symlinked or invalid: ${target}`);
}
async function seed(source: string, target: string, budget: { files: number; bytes: number }, protectedInputs: string[]) {
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new Error(`Output seed contains symlink or special file: ${from}`);
    const protectedEntry = protectedInputs.some(input => within(input, from));
    if (entry.isDirectory()) { if (!protectedEntry || protectedInputs.includes(from)) await directory(to); await seed(from, to, budget, protectedInputs); }
    else {
      if (protectedEntry && !protectedInputs.includes(from)) continue;
      if (!protectedEntry) {
        budget.files++; budget.bytes += (await fs.stat(from)).size;
        if (budget.files > 10_000 || budget.bytes > 256 * 1024 * 1024) throw new Error('Output seed exceeds archive limit');
      }
      try { if (protectedEntry) await fs.writeFile(to, '', { flag: 'wx' }); else await fs.copyFile(from, to, constants.COPYFILE_EXCL); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    }
  }
}

export async function prepareGraphOutputRuntime(nodeId: string, attempt: string, workspaces: string[]) {
  const root = path.join(validationRuntimeDirectory(nodeId), hash('outputs:' + attempt));
  await directory(root);
  const bindings: { source: string; target: string; readOnly: boolean }[] = [{ source: root, target: root, readOnly: false }];
  const outputMap: Record<string, string> = {};
  for (const workspace of Array.from(new Set(workspaces))) {
    const canonical = await fs.realpath(workspace);
    const policy = outputDeclaration(canonical);
    if (policy.paths.length && await graphGit(canonical, 'rev-parse', '--path-format=absolute', '--git-dir') === await graphGit(canonical, 'rev-parse', '--path-format=absolute', '--git-common-dir')) throw new Error('Output mapping requires an isolated linked worktree, not the original repository');
    const targets = policy.paths.map(name => path.join(canonical, name));
    if (targets.some((target, index) => targets.some((other, otherIndex) => index !== otherIndex && within(other, target)))) throw new Error('Output declarations overlap');
    for (const name of policy.paths) {
      const target = path.join(canonical, name);
      if (await graphGit(canonical, 'ls-files', '-z', '--', name)) throw new Error(`Output declaration contains tracked input: ${name}`);
      await graphGit(canonical, 'check-ignore', '-q', '--no-index', '--', name + '/').catch(() => { throw new Error(`Output declaration must be ignored: ${name}`); });
      await directory(target);
      const source = path.join(root, 'legacy', hash(canonical), name);
      await directory(source);
      await seed(target, source, { files: 0, bytes: 0 }, policy.readOnlyPaths.map(input => path.join(canonical, input)));
      bindings.push({ source, target, readOnly: false }); outputMap[target] = source;
      for (const input of policy.readOnlyPaths.filter(input => within(name, input))) {
        const protectedSource = path.join(source, path.relative(name, input));
        const protectedTarget = path.join(canonical, input);
        if (await fs.realpath(protectedTarget) !== protectedTarget || await fs.realpath(protectedSource) !== protectedSource) throw new Error('Protected output input is symlinked');
        bindings.push({ source: protectedTarget, target: protectedTarget, readOnly: true });
        bindings.push({ source: protectedTarget, target: protectedSource, readOnly: true });
      }
    }
    if (policy.readOnlyPaths.some(input => !policy.paths.some(output => within(output, input)))) throw new Error('Protected output input must belong to a declared output');
  }
  for (const name of ['__pycache__', '.cache/npm', 'tmp']) await directory(path.join(root, name));
  const env = { AP_GRAPH_OUTPUT_DIR: root, TASK_GRAPH_OUTPUT_DIR: root, AP_GRAPH_OUTPUT_BINDINGS_JSON: JSON.stringify(bindings), AP_GRAPH_OUTPUT_PATHS_JSON: JSON.stringify(outputMap),
    PYTHONPYCACHEPREFIX: path.join(root, '__pycache__'), XDG_CACHE_HOME: path.join(root, '.cache'), NPM_CONFIG_CACHE: path.join(root, '.cache/npm'), TMPDIR: path.join(root, 'tmp') };
  return { directory: root, env, instructions: `\n本阶段报告、缓存及临时数据库写入 AP_GRAPH_OUTPUT_DIR=${root}。沿用现有项目解释器，不创建虚拟环境。显式旧输出目录已隔离映射：${JSON.stringify(outputMap)}；输入只读，原有报告保留。先前阶段产物位于只读运行记录目录 ${validationRuntimeDirectory(nodeId)}，可读取但不得修改。` };
}
