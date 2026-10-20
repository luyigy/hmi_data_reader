// Read committed blobs only. No application imports, database access or index updates.
const { execFileSync } = require('node:child_process');
const path = require('node:path').posix;
const assert = require('node:assert/strict');
const ts = require('typescript');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

function components(vertices, edges) {
  const adjacency = new Map(vertices.map(v => [v, []]));
  for (const [from, to] of edges) adjacency.get(from)?.push(to);
  let next = 0;
  const index = new Map(), low = new Map(), stack = [], active = new Set(), result = [];
  function visit(v) {
    index.set(v, next); low.set(v, next++); stack.push(v); active.add(v);
    for (const w of adjacency.get(v) || []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (active.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) !== index.get(v)) return;
    const group = [];
    let w;
    do { w = stack.pop(); active.delete(w); group.push(w); } while (w !== v);
    if (group.length > 1) result.push(group.sort());
  }
  for (const v of vertices) if (!index.has(v)) visit(v);
  return result.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

function inspect(file, content) {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const imports = [], calls = [], writes = [], functions = [];
  const line = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  function visit(node, owner = '<module>') {
    if (ts.isFunctionDeclaration(node) && node.name) {
      owner = node.name.text; functions.push({ name: owner, line: line(node) });
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      owner = node.name.text; functions.push({ name: owner, line: line(node) });
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const names = bindings && ts.isNamedImports(bindings) ? bindings.elements.map(item => ({
        local: item.name.text, imported: item.propertyName?.text || item.name.text,
        typeOnly: !!clause.isTypeOnly || item.isTypeOnly,
      })) : [];
      if (clause?.name) names.push({ local: clause.name.text, imported: 'default', typeOnly: !!clause.isTypeOnly });
      const typeOnly = ts.isImportDeclaration(node)
        ? !!clause?.isTypeOnly || (!!names.length && names.every(item => item.typeOnly))
        : !!node.isTypeOnly || !!node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every(item => item.isTypeOnly);
      imports.push({ specifier: node.moduleSpecifier.text, line: line(node), typeOnly, names });
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression)) calls.push({ caller: owner, callee: expression.text, line: line(node) });
      const parts = [];
      let cursor = expression;
      while (ts.isPropertyAccessExpression(cursor)) { parts.unshift(cursor.name.text); cursor = cursor.expression; }
      if (ts.isIdentifier(cursor)) parts.unshift(cursor.text);
      if (parts.length === 3 && /^taskGraph/.test(parts[1]) && /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(parts[2])) {
        const fields = new Set();
        function dataFields(value) {
          if (ts.isPropertyAssignment(value) && value.name.getText(source) === 'data' && ts.isObjectLiteralExpression(value.initializer)) {
            for (const field of value.initializer.properties) fields.add(field.name?.getText(source) || '<spread>');
          }
          ts.forEachChild(value, dataFields);
        }
        for (const argument of node.arguments) dataFields(argument);
        writes.push({ function: owner, receiver: parts[0], model: parts[1], operation: parts[2], line: line(node), fields: [...fields].sort() });
      }
    }
    ts.forEachChild(node, child => visit(child, owner));
  }
  visit(source);
  return { imports, calls, writes, functions, lines: content.split('\n').length - (content.endsWith('\n') ? 1 : 0) };
}

// Counterexamples: a one-way edge is not a cycle; type-only imports are not runtime edges.
assert.deepEqual(components(['a', 'b', 'c'], [['a', 'b'], ['b', 'a'], ['b', 'c']]), [['a', 'b']]);
const fixture = inspect('fixture.ts', "import { type A } from './a'; import { run as go } from './b'; export async function f(){ await tx.taskGraphExecution.update({data:{status:'ready'}}); go(); } ");
assert.equal(fixture.imports[0].typeOnly, true);
assert.equal(fixture.imports[1].names[0].imported, 'run');
assert.deepEqual(fixture.writes[0].fields, ['status']);
assert.equal(fixture.calls[0].caller, 'f');
assert.equal(fixture.calls[0].callee, 'go');

const ref = process.argv[2] || 'HEAD';
if (!/^[A-Za-z0-9_./-]+$/.test(ref) || ref.startsWith('-')) throw Error('Invalid Git ref');
const commit = git('rev-parse', '--verify', `${ref}^{commit}`).trim();
const paths = git('ls-tree', '-r', '--name-only', commit, '--', 'src', 'scripts').trim().split('\n')
  .filter(file => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file) && !/\.(test|spec)\./.test(file)).sort();
const files = new Map(paths.map(file => [file, inspect(file, git('show', `${commit}:${file}`))]));
function resolve(from, specifier) {
  const base = specifier.startsWith('.') ? path.normalize(path.join(path.dirname(from), specifier))
    : specifier.startsWith('@/') ? `src/${specifier.slice(2)}` : null;
  if (!base) return null;
  return [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map(ext => base + ext),
    ...['/index.ts', '/index.tsx', '/index.js'].map(ext => base + ext)].find(file => files.has(file)) || null;
}
const edges = [], unresolved = [], calls = [], writes = [];
for (const [file, info] of files) {
  const bindings = new Map();
  for (const item of info.imports) {
    const target = resolve(file, item.specifier);
    if (target) edges.push({ from: file, to: target, line: item.line, typeOnly: item.typeOnly });
    else if (item.specifier.startsWith('.') || item.specifier.startsWith('@/')) unresolved.push({ file, line: item.line, specifier: item.specifier });
    if (target) for (const name of item.names) if (!name.typeOnly) bindings.set(name.local, { file: target, name: name.imported });
  }
  const local = new Set(info.functions.map(item => item.name));
  for (const call of info.calls) {
    const target = bindings.get(call.callee) || (local.has(call.callee) ? { file, name: call.callee } : null);
    if (target) calls.push({ from: { file, name: call.caller }, to: target, line: call.line });
  }
  writes.push(...info.writes.map(write => ({ file, ...write })));
}
const scope = file => /^(src\/lib\/(task-graph|project-capabilities|acpx|harness)\/|src\/lib\/feishu-|src\/lib\/live-room|src\/app\/api\/task|scripts\/task-graph)/.test(file);
const scoped = paths.filter(scope);
const scopeEdges = edges.filter(edge => scope(edge.from) && scope(edge.to));
const traceFiles = new Set([
  'propose-spec', 'issue-route', 'proposals', 'store', 'coordinator', 'conversation-inbox',
  'conversation-session', 'conversation-followup', 'architecture-review', 'review-result',
  'repair', 'pending-review-repair', 'check-environment', 'runtime-continuity',
].map(name => `src/lib/task-graph/${name}.ts`));
traceFiles.add('src/lib/acpx/runner.ts');
traceFiles.add('src/lib/acpx/runner-harness.ts');
traceFiles.add('src/lib/project-capabilities/task-runtime.ts');
const traceCalls = calls.filter(call => traceFiles.has(call.from.file));
const summary = {
  commit, parserVersion: ts.version, scannedFiles: paths.length, scopedFiles: scoped.length,
  importEdges: edges.length, scopedImportEdges: scopeEdges.length,
  runtimeSyntaxComponents: components(paths, edges.filter(edge => !edge.typeOnly).map(edge => [edge.from, edge.to]))
    .filter(group => group.some(scope)),
  scopedTopFanOut: scoped.map(file => ({ file, imports: edges.filter(edge => edge.from === file && !edge.typeOnly).length, lines: files.get(file).lines }))
    .sort((a, b) => b.imports - a.imports || a.file.localeCompare(b.file)).slice(0, 12),
  graphWrites: writes.length,
  directCallCandidates: traceCalls.length,
  executionWriterFiles: [...new Set(writes.filter(write => write.model === 'taskGraphExecution').map(write => write.file))].sort(),
};
const result = {
  methodology: 'Committed src/scripts only; TypeScript AST. Imports include re-exports; type-only syntax excluded from runtime-syntax SCCs. Runtime-syntax edges may be elided by compilation. Calls resolve direct identifier imports/local declarations only, not a full semantic call graph. Nested callbacks inherit their enclosing named function; local shadowing and same-named nested functions are not resolved. Prisma writes are syntactic candidates, not authorization violations; aliases/raw SQL/computed access/dynamic imports/require are not resolved. Unresolved lists static relative/@ imports outside this scan or unsupported resolution. Scope is an audit filter, not an approved boundary rule.',
  selfChecks: 'passed', summary,
  files: scoped.map(file => ({ file, lines: files.get(file).lines })),
  traceFiles: [...traceFiles].sort(), imports: scopeEdges, calls: traceCalls, writes, unresolved,
};
// One evidence row per line keeps generated diffs reviewable.
const rows = Object.entries(result).map(([key, value]) => `  ${JSON.stringify(key)}: ` + (Array.isArray(value)
  ? '[\n' + value.map(item => '    ' + JSON.stringify(item)).join(',\n') + '\n  ]'
  : JSON.stringify(value, null, 2).replaceAll('\n', '\n  ')));
process.stdout.write('{\n' + rows.join(',\n') + '\n}\n');
