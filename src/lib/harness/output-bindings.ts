import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

const git = (directory: string, ...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function relativePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50 || !value.every((entry: unknown) => typeof entry === 'string' && !path.isAbsolute(entry) && entry.split(/[\\/]/).every(part => !!part && part !== '.' && part !== '..' && !['.git', '.venv', 'venv', 'node_modules'].includes(part)))) throw new Error('Output paths must be relative and outside dependencies');
  return value;
}
export function outputDeclaration(workspace: string) {
  const config = path.join(workspace, '.agent-platform/outputs.json');
  if (!existsSync(config)) return { paths: [], readOnlyPaths: [] };
  if (realpathSync(config) !== config || !lstatSync(config).isFile()) throw new Error('Output declaration is symlinked or invalid');
  if (!git(workspace, 'ls-files', '-z', '--', '.agent-platform/outputs.json')) throw new Error('Output declaration must be tracked');
  const value: unknown = JSON.parse(git(workspace, 'show', 'HEAD:.agent-platform/outputs.json'));
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('paths' in value)) throw new Error('Invalid output declaration');
  return { paths: relativePaths(value.paths), readOnlyPaths: 'readOnlyPaths' in value ? relativePaths(value.readOnlyPaths) : [] };
}
type OutputBinding = { source: string; target: string; readOnly: boolean };
function parseBindings(value: unknown): OutputBinding[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid output bindings');
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('source' in entry) || typeof entry.source !== 'string' || !('target' in entry) || typeof entry.target !== 'string' || !('readOnly' in entry) || typeof entry.readOnly !== 'boolean') throw new Error('Invalid output binding');
    return { source: entry.source, target: entry.target, readOnly: entry.readOnly };
  });
}
const within = (root: string, target: string) => target === root || target.startsWith(root + path.sep);

/** Platform-produced mounts are confined to this runtime and explicitly visible workspaces. */
export function sandboxOutputBindings(env: NodeJS.ProcessEnv, workspace: string, readOnlyPaths: string[]) {
  if (!env.AP_GRAPH_OUTPUT_BINDINGS_JSON) return [];
  const root = env.AP_GRAPH_OUTPUT_DIR;
  if (!root || !path.isAbsolute(root) || realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('Invalid graph output runtime');
  const visible = [workspace, ...readOnlyPaths.filter(entry => lstatSync(entry).isDirectory()).map(entry => realpathSync(entry))];
  const declaredInput = (source: string) => visible.some(owner => within(owner, source) && existsSync(path.join(owner, '.agent-platform/outputs.json')) && outputDeclaration(owner).readOnlyPaths.includes(path.relative(owner, source)));
  return parseBindings(JSON.parse(env.AP_GRAPH_OUTPUT_BINDINGS_JSON)).map(binding => {
    if (!path.isAbsolute(binding.source) || !path.isAbsolute(binding.target) || realpathSync(binding.source) !== binding.source || realpathSync(binding.target) !== binding.target || !within(root, binding.source) && !(binding.readOnly && declaredInput(binding.source))) throw new Error('Graph output binding escapes runtime or uses symlink');
    if (!within(root, binding.target) && !visible.some(directory => binding.target !== directory && within(directory, binding.target))) throw new Error('Graph output target is outside visible workspace');
    if (!within(root, binding.target)) {
      const owner = visible.filter(directory => within(directory, binding.target) && existsSync(path.join(directory, '.agent-platform/outputs.json'))).sort((a, b) => b.length - a.length)[0];
      if (!owner) throw new Error('Output binding has no declared workspace');
      const declared = outputDeclaration(owner);
      const relative = path.relative(owner, binding.target);
      if (!(binding.readOnly ? declared.readOnlyPaths.includes(relative) : declared.paths.includes(relative))) throw new Error('Output binding target is not explicitly declared');
      if (git(owner, 'ls-files', '-z', '--', relative)) throw new Error('Output binding masks tracked input');
      git(owner, 'check-ignore', '-q', '--no-index', '--', relative + '/');
    }
    if (path.relative(workspace, binding.target).split(path.sep).some(part => ['.git', '.venv', 'venv', 'node_modules'].includes(part))) throw new Error('Graph output cannot expose dependencies or Git metadata');
    return binding;
  });
}
