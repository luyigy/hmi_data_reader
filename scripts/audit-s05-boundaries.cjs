// Read-only source census. This is a review aid, not a concurrency or safety proof.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const baseline = '2f4b9959f1d4f538fffbc5def0faf8b5bc838863';
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const out = path.join(root, 'docs/evidence/s05-boundary-inventory-20261024');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const hash = text => createHash('sha256').update(text).digest('hex');
const files = git('ls-tree', '-r', '--name-only', baseline, 'src').trim().split('\n').filter(f => /\.tsx?$/.test(f));
const graph = 'src/lib/task-graph/';
const sources = new Map();
// One git archive process keeps the scan inexpensive and never executes application code.
const archive = execFileSync('git', ['archive', baseline, 'src'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
for (let offset = 0; offset + 512 <= archive.length;) {
  const header = archive.subarray(offset, offset + 512);
  const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
  if (!name) break;
  const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0;
  const prefix = header.subarray(345, 500).toString().replace(/\0.*$/s, '');
  const file = prefix ? `${prefix}/${name}` : name;
  if (files.includes(file)) sources.set(file, archive.subarray(offset + 512, offset + 512 + size).toString());
  offset += 512 + Math.ceil(size / 512) * 512;
}
if (sources.size !== files.length) throw new Error('Archive/source list mismatch');
const parsed = new Map([...sources].map(([file, text]) => [file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)]));
function visit(node, fn) { fn(node); ts.forEachChild(node, child => visit(child, fn)); }
function owner(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if (ts.isMethodDeclaration(p)) return p.name.getText();
    if (ts.isVariableDeclaration(p) && p.initializer && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return p.name.getText();
  }
  return '<module>';
}
const at = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
function entry(file, sf, node, kind, name) {
  const calls = [], locks = [];
  visit(node, child => {
    if (ts.isCallExpression(child)) calls.push({ line: at(sf, child), name: child.expression.getText(sf) });
    if (ts.isTaggedTemplateExpression(child) && /FOR (?:NO KEY )?UPDATE|pg_(?:try_)?advisory/.test(child.template.getText(sf))) locks.push({ line: at(sf, child), sql: child.template.getText(sf) });
  });
  return { id: `${file}:${at(sf, node)}`, file, line: at(sf, node), endLine: sf.getLineAndCharacterOfPosition(node.end).line + 1,
    kind, owner: name || owner(node), sha256: hash(node.getText(sf)), calls, locks, source: node.getText(sf) };
}
const helpers = [];
for (const [file, sf] of parsed) if (file.startsWith(graph)) visit(sf, node => {
  if (ts.isFunctionDeclaration(node) && node.body && node.parameters.some(p => /TransactionClient/.test(p.type?.getText(sf) || ''))) helpers.push(entry(file, sf, node, 'tx-helper', node.name.text));
});
const helperNames = new Set(helpers.map(h => h.owner));
const transactions = [], externalReferences = [];
for (const [file, sf] of parsed) {
  // Named import aliases are resolved for the direct helper-reference census.
  const aliases = new Map();
  for (const statement of sf.statements) if (ts.isImportDeclaration(statement)) {
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) {
      if (helperNames.has((el.propertyName || el.name).text)) aliases.set(el.name.text, (el.propertyName || el.name).text);
    }
  }
  visit(sf, node => {
    if (!ts.isCallExpression(node)) return;
    const expr = node.expression;
    const helper = ts.isIdentifier(expr) ? aliases.get(expr.text) || (file.startsWith(graph) && helperNames.has(expr.text) ? expr.text : undefined) : undefined;
    if (helper && !file.startsWith(graph)) externalReferences.push({ file, line: at(sf, node), owner: owner(node), helper });
    if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== '$transaction') return;
    const row = entry(file, sf, node, ts.isArrayLiteralExpression(node.arguments[0]) ? 'transaction-array' : 'transaction-callback');
    if (file.startsWith(graph) || /taskGraph|TaskGraph/.test(row.source) || row.calls.some(c => helperNames.has(aliases.get(c.name) || c.name))) transactions.push(row);
  });
}
const supplemental = ['src/lib/project-capabilities/context.ts', 'src/lib/project-capabilities/tool-runtime.ts',
  'src/lib/project-capabilities/scope-resolution.ts', 'src/lib/project-capabilities/policy.ts',
  'src/lib/feishu-task-entry-api.ts', 'src/lib/feishu-access-approval.ts'];
const relatedFiles = new Set([...files.filter(f => f.startsWith(graph)), ...transactions.map(t => t.file), ...externalReferences.map(t => t.file), ...supplemental]);
const behaviorPaths = [
  ['src/lib/task-graph/coordinator.ts', 'executeJob'],
  ['src/lib/task-graph/implementation-result.ts', 'pauseGraphImplementation'],
  ['src/lib/task-graph/phase-worker.ts', 'observeExecutionWriter'],
  ['src/lib/task-graph/writer-ownership.ts', 'observeTaskRunWriter'],
  ['src/lib/task-graph/runtime-preflight.ts', 'prepareDeclaredRuntime'],
].flatMap(([file, name]) => {
  const rows = [], sf = parsed.get(file);
  visit(sf, node => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) rows.push(entry(file, sf, node, 'behavior-path', name)); });
  if (rows.length !== 1) throw new Error(`Behavior source not found: ${file}#${name}`);
  return rows;
});
const inventory = { baseline, method: 'AST census of all src TypeScript; graph transactions plus external transactions containing taskGraph text or named Tx-helper calls. Calls are lexical, not inferred runtime order. No transitive safety proof; dynamic/namespace references and implicit SQL locks require manual review.',
  counts: { scannedSourceFiles: files.length, graphSourceFiles: files.filter(f => f.startsWith(graph)).length, transactions: transactions.length, txHelpers: helpers.length, externalReferences: externalReferences.length },
  manifest: [...relatedFiles].sort().map(file => ({ file, sha256: hash(sources.get(file)) })), transactions, helpers, externalReferences, behaviorPaths };
const serialized = JSON.stringify(inventory, null, 2) + '\n';
const target = path.join(out, 'inventory.json');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== serialized) throw new Error('Saved inventory differs from fixed-source census');
  const assessment = JSON.parse(fs.readFileSync(path.join(out, 'assessment.json'), 'utf8'));
  if (assessment.baseline !== baseline) throw new Error('Assessment baseline mismatch');
  const expected = [...transactions, ...helpers].map(r => r.id).sort();
  for (const finding of assessment.findings) {
    if (!finding.verification || finding.entries.some(id => !assessment.entries[id])) throw new Error(`Invalid finding: ${finding.id}`);
  }
  const actual = Object.keys(assessment.entries).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Missing/extra manual entry dispositions');
  for (const [id, row] of Object.entries(assessment.entries)) {
    if (!row.status || !row.locks || !row.io || !row.next || !row.reason) throw new Error(`Incomplete disposition: ${id}`);
  }
  for (const f of inventory.manifest) if (hash(fs.readFileSync(path.join(root, f.file))) !== f.sha256) throw new Error(`Working source differs: ${f.file}`);
  console.log('PASS fixed baseline, source hashes, reproducible census, and one disposition per transaction/helper');
  console.log('LIMIT: static inventory consistency only; no runtime, lock, budget or S05 completion claim');
} else {
  fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(target, serialized);
}
console.log(JSON.stringify(inventory.counts));
if (!process.argv.includes('--check')) for (const r of transactions) console.log(`${r.id} ${r.owner}`);
