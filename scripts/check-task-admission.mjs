import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';

const root = 'src/lib/task-graph';
const property = (object, name) => ts.isObjectLiteralExpression(object)
  ? object.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText().replace(/['"]/g, '') === name)?.initializer : undefined;
const literal = value => value && ts.isStringLiteral(value) ? value.text : undefined;

export function violations(file, source) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const failures = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(parsed);
      for (const arg of node.arguments) {
        const data = property(arg, 'data');
        if (/\.taskGraphExecution\.update(Many)?$/.test(callee) && literal(data && property(data, 'status')) === 'ready' && file !== 'execution-progress.ts') {
          const where = property(arg, 'where');
          if (!(file === 'store.ts' && literal(where && property(where, 'status')) === 'planned')) failures.push('Execution admission must use admitNode and applyExecutionOutcomeTx');
        }
        const outcome = property(arg, 'outcome'), kind = literal(outcome && property(outcome, 'kind'));
        if (['operator_resume', 'review_resumed', 'review_platform_prepared'].includes(kind)) failures.push('Migrate the recovery caller to admitNode');
        if (['admitted', 'admission_deferred'].includes(kind) && file !== 'preparation-recovery.ts') failures.push('Only admitNode may submit an admission outcome');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return failures;
}

const fixtures = [
  ['conversation-inbox.ts', "tx.taskGraphExecution.update({where:{id},data:{status:'ready'}})", true],
  ['preparation-recovery.ts', "tx.taskGraphExecution.updateMany({where:{status:'attention'},data:{status:'ready'}})", true],
  ['store.ts', "tx.taskGraphExecution.updateMany({where:{status:'attention'},data:{status:'ready'}})", true],
  ['store.ts', "tx.taskGraphExecution.updateMany({where:{status:'planned'},data:{status:'ready'}})", false],
  ['conversation-inbox.ts', "applyExecutionOutcomeTx(tx,{outcome:{kind:'operator_resume'}})", true],
  ['coordinator.ts', "applyExecutionOutcome({outcome:{kind:'admitted'}})", true],
];
for (const [file, source, rejected] of fixtures) assert.equal(violations(file, source).length > 0, rejected, source);
const errors = fs.readdirSync(root).filter(file => file.endsWith('.ts')).flatMap(file => violations(file, fs.readFileSync(path.join(root, file), 'utf8')).map(error => `${file}: ${error}`));
assert.deepEqual(errors, [], errors.join('\n'));
console.log(`Ticket admission AST gate passed; ${fixtures.length} boundary counterexamples checked. Covers direct Prisma writes and literal outcome calls; dynamic aliases are outside this static check.`);
