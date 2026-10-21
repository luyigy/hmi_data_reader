import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface WireFinding { wire: 'W001'; file: string; line: number; message: string }
const runner = 'src/lib/acpx/runner-harness.ts';
const dispatch = 'src/lib/acpx/stage-harness-dispatch.ts';
const prompt = 'src/lib/acpx/prompt.ts';
const producers = new Map([
  ['src/lib/task-graph/coordinator.ts', 1],
  ['src/lib/task-graph/conversation-followup.ts', 1],
  ['src/lib/task-graph/review-result.ts', 1],
]);
function sources(directory = 'src/lib'): Map<string, string> {
  const result = new Map<string, string>();
  function visit(root: string) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith('.ts')) result.set(file.split(path.sep).join('/'), fs.readFileSync(file, 'utf8'));
    }
  }
  visit(directory);
  return result;
}
function nodes(root: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  function visit(node: ts.Node) { result.push(node); ts.forEachChild(node, visit); }
  visit(root);
  return result;
}
function identifier(node: ts.Node | undefined, name: string): boolean { return !!node && ts.isIdentifier(node) && node.text === name; }
function property(node: ts.Node | undefined, owner: string, name: string): boolean {
  return !!node && ts.isPropertyAccessExpression(node) && identifier(node.expression, owner) && node.name.text === name;
}
function member(node: ts.Node | undefined, name: string): node is ts.PropertyAccessExpression {
  return !!node && ts.isPropertyAccessExpression(node) && node.name.text === name;
}
function field(node: ts.ObjectLiteralExpression | undefined, name: string): ts.Expression | undefined {
  const value = node?.properties.find(item => (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item))
    && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name);
  return value && ts.isPropertyAssignment(value) ? value.initializer : value && ts.isShorthandPropertyAssignment(value) ? value.name : undefined;
}
function imports(sf: ts.SourceFile, exported: string): Set<string> {
  const names = new Set<string>();
  for (const item of sf.statements) {
    if (!ts.isImportDeclaration(item)) continue;
    const bindings = item.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const entry of bindings.elements)
      if ((entry.propertyName || entry.name).text === exported) names.add(entry.name.text);
  }
  return names;
}
function positiveGraphCheck(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return positiveGraphCheck(node.expression);
  if (ts.isCallExpression(node)) return identifier(node.expression, 'isGraphStageRequest');
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken
    && (positiveGraphCheck(node.left) || positiveGraphCheck(node.right));
}
function callNamed(call: ts.CallExpression, names: Set<string>, exported: string): boolean {
  // Namespace imports are also covered; dynamic require/reflective aliases are outside this static gate.
  return ts.isIdentifier(call.expression) ? names.has(call.expression.text)
    : ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === exported
      || ts.isElementAccessExpression(call.expression) && ts.isStringLiteral(call.expression.argumentExpression) && call.expression.argumentExpression.text === exported;
}

/** Checks the registered source topology and dispatch expressions, not arbitrary JavaScript data flow. */
export function checkStageExecutionWire(files: Map<string, string> = sources()): WireFinding[] {
  const findings: WireFinding[] = [];
  const parsed = new Map(Array.from(files).map(([file, source]) => [file, ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)]));
  const report = (file: string, node: ts.Node | undefined, message: string) => {
    const sf = parsed.get(file);
    findings.push({ wire: 'W001', file, line: sf && node ? sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 : 1, message });
  };
  const requireFile = (file: string) => {
    const sf = parsed.get(file);
    if (!sf) report(file, undefined, 'Required Stage Execution Contract boundary is missing');
    return sf;
  };
  for (const [file, sf] of Array.from(parsed)) {
    const all = nodes(sf), calls = all.filter(ts.isCallExpression);
    if (file.startsWith('src/lib/task-graph/')) {
      const executeNames = imports(sf, 'executeAcpxTaskRun');
      const graphCalls = calls.filter(call => callNamed(call, executeNames, 'executeAcpxTaskRun'));
      const expected = producers.get(file) || 0;
      if (graphCalls.length !== expected) report(file, graphCalls[0], `Graph execution callsite count ${graphCalls.length}; registered ${expected}. Review and register Stage Request ownership`);
      const sessionNames = imports(sf, 'implementationConversation');
      for (const call of calls.filter(item => callNamed(item, sessionNames, 'implementationConversation')))
        if (call.arguments.length !== 2) report(file, call, 'Session selection must not accept a separate stage message');
      for (const item of all.filter(ts.isFunctionDeclaration)) {
        if (item.name?.text === 'implementationConversation' && item.parameters.length !== 2)
          report(file, item, 'Session selector must contain only execution identity and participant');
      }
    }
    if (file === runner) {
      for (const call of calls) {
        if ((ts.isPropertyAccessExpression(call.expression) && identifier(call.expression.expression, 'adapter')
          && ['execute', 'resume'].includes(call.expression.name.text))
          || (ts.isElementAccessExpression(call.expression) && identifier(call.expression.expression, 'adapter')
            && ts.isStringLiteral(call.expression.argumentExpression) && ['execute', 'resume'].includes(call.expression.argumentExpression.text)))
          report(file, call, 'Direct adapter lifecycle bypasses executePreparedStageHarness');
      }
      if (!calls.some(call => identifier(call.expression, 'executePreparedStageHarness')))
        report(file, sf, 'Local dispatch must use executePreparedStageHarness');
      if (!calls.some(call => property(call.expression, 'StageExecutionRequest', 'create')))
        report(file, sf, 'Finalized runtime must construct StageExecutionRequest');
      if (calls.filter(call => identifier(call.expression, 'captureStageAuthority')).length < 2)
        report(file, sf, 'Capture stage authority before preparation and fresh before dispatch');
      for (const call of calls) {
        if (!identifier(call.expression, 'executeRemoteRunnerTask') && !identifier(call.expression, 'executeRemoteSshTask')) continue;
        for (const argument of call.arguments.filter(ts.isObjectLiteralExpression)) {
          for (const name of ['prompt', 'continuationMessage']) {
            const value = field(argument, name);
            if (value && !nodes(value).some(node => ts.isCallExpression(node) && identifier(node.expression, 'harnessContinuationInput')))
              report(file, value, `Remote ${name} must use the current-stage continuation selector`);
          }
        }
      }
    }
  }
  for (const file of Array.from(producers.keys())) requireFile(file);
  requireFile(runner);
  const boundary = requireFile(dispatch);
  if (boundary) {
    const all = nodes(boundary), calls = all.filter(ts.isCallExpression);
    const validation = calls.find(call => property(call.expression, 'stageRequest', 'assertMatches'));
    const refusal = all.filter(ts.isIfStatement).some(statement =>
      nodes(statement.expression).some(node => ts.isCallExpression(node) && identifier(node.expression, 'isGraphStageRequest'))
      && nodes(statement.expression).some(node => ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken && identifier(node.operand, 'stageRequest'))
      && nodes(statement.thenStatement).some(ts.isThrowStatement));
    if (!refusal) report(dispatch, boundary, 'Graph dispatch must refuse a missing StageExecutionRequest');
    if (!validation || !ts.isObjectLiteralExpression(validation.arguments[0])
      || !identifier(field(validation.arguments[0], 'authority'), 'authority')
      || !identifier(field(validation.arguments[0], 'runtime'), 'runtime'))
      report(dispatch, validation || boundary, 'Dispatch must validate stageRequest against fresh authority and runtime');
    const declaration = (name: string) => all.find((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && identifier(node.name, name));
    const message = declaration('message')?.initializer;
    if (!message || !ts.isConditionalExpression(message) || !identifier(message.condition, 'stageRequest')
      || !property(message.whenTrue, 'stageRequest', 'prompt') || !ts.isCallExpression(message.whenFalse)
      || !identifier(message.whenFalse.expression, 'harnessContinuationInput'))
      report(dispatch, message || boundary, 'Current stage message must select stageRequest.prompt with only a non-stage fallback');
    const task = declaration('currentTask')?.initializer;
    if (!task || !ts.isObjectLiteralExpression(task) || !identifier(field(task, 'description'), 'message'))
      report(dispatch, task || boundary, 'Current task description must use the identical validated message');
    const adapterCalls = calls.filter(call => member(call.expression, 'execute') || member(call.expression, 'resume'));
    for (const kind of ['execute', 'resume']) {
      const matching = adapterCalls.filter(call => member(call.expression, kind));
      if (matching.length !== 1) report(dispatch, boundary, `Expected one shared adapter.${kind} dispatch`);
      for (const call of matching) {
        const input = call.arguments[0];
        if (!input || !ts.isObjectLiteralExpression(input) || !identifier(field(input, 'task'), 'currentTask')
          || kind === 'resume' && !identifier(field(input, 'continuationMessage'), 'message'))
          report(dispatch, call, `${kind} must receive currentTask and the identical current-stage message`);
        if (!validation || validation.getStart() >= call.getStart()) report(dispatch, call, 'Stage validation must precede dispatch');
      }
    }
  }
  const selector = requireFile(prompt);
  if (selector) {
    const fn = nodes(selector).find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'harnessContinuationInput');
    const result = fn?.body?.statements.find(ts.isReturnStatement)?.expression;
    const graphCheck = result && ts.isConditionalExpression(result) && positiveGraphCheck(result.condition);
    if (!result || !ts.isConditionalExpression(result) || !graphCheck || !identifier(result.whenTrue, 'prepared'))
      report(prompt, fn || selector, 'Graph continuation must return prepared current-stage input');
  }
  return findings;
}
if (require.main === module) {
  const findings = checkStageExecutionWire();
  for (const finding of findings) console.error(`${finding.wire} ${finding.file}:${finding.line}: ${finding.message}`);
  if (findings.length) process.exitCode = 1;
  else console.log('W001 Stage Execution Contract source boundaries passed');
}
