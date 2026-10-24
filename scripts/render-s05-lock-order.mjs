import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'docs/evidence/s05-lock-order-20261024');
const read = name => fs.readFileSync(path.join(directory, name), 'utf8');
const records = name => read(name).split('\n').filter(line => line.startsWith('{"kind"')).map(line => JSON.parse(line));
const red = records('red.log'), green = records('green.log');
const cycle = entry => entry.samples.some(sample => sample.activity.some(row => row.pid === entry.holderPid && row.blockers.includes(entry.contenderPid)) && sample.activity.some(row => row.pid === entry.contenderPid && row.blockers.includes(entry.holderPid)));
const rowWait = entry => entry.samples.some(sample => sample.activity.some(row => entry.probePids.includes(row.pid) && row.blockers.includes(entry.contenderPid)));
assert.equal(red.length, 9); assert.equal(green.length, 9);
const scenarios = green.map(after => {
  const before = red.find(entry => entry.kind === after.kind); assert(before);
  assert.equal(after.results[1].status, 'fulfilled'); assert.equal(cycle(after), false); assert.equal(rowWait(after), false);
  return { name: after.kind, beforeCycle: cycle(before), beforeRowWait: rowWait(before), afterCycle: cycle(after), afterRowWait: rowWait(after),
    beforeResult: before.results[1], afterResult: after.results[1].status,
    revision: [after.before.dispatchMetadata.progress.revision, after.after.dispatchMetadata.progress.revision],
    budget: [after.before.dispatchMetadata.progress.platformAttempts, after.after.dispatchMetadata.progress.platformAttempts],
    status: after.after.status };
});
assert.equal(scenarios.filter(row => row.beforeCycle).length, 7);
assert.equal(scenarios.filter(row => row.beforeRowWait).length, 3);
assert.equal(read('red.log').split('\n').filter(line => line.startsWith('PASS ')).length, 11);
assert.equal(read('green.log').split('\n').filter(line => line.startsWith('PASS ')).length, 18);
const runs = ['red', 'green', 'publication', 'compatibility', 'recovery-compatibility', 'admission', 'issue-sync-baseline'].map(name => {
  const db = JSON.parse(read(name + '-database.json'));
  assert(db.insideSandbox && db.cleanup.lifecycleClosed && db.cleanup.portClosed && db.cleanup.directoryRemoved);
  assert(db.steps.find(step => step.name === 'suite-schema-cleanup').ok);
  const exit = db.steps.find(step => step.name === 'regression-suite').exitCode;
  assert.equal(exit, ['red', 'recovery-compatibility', 'issue-sync-baseline'].includes(name) ? 1 : 0);
  const serverLogs = db.cleanup.receipts.flatMap(receipt => receipt.receipts).map(receipt => receipt.log || '').join('\n');
  return { name, exit, suites: db.suites, cleanup: 'schema/service/port/directory PASS',
    deadlocks: (serverLogs.match(/ERROR: {2}deadlock detected/g) || []).length };
});
const manifest = ['src/lib/task-graph/restart-recovery.ts', 'src/lib/task-graph/reclassify-delivery.ts',
  'tests/task-graph-recovery-lock-order.test.ts', 'tests/fixtures/graph-lock-rendezvous.ts', 'scripts/test-task-graph-postgres.mjs'].map(file => ({ file,
  sha256: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }));
const summary = { baseline: 'dee66bc56a3dab8ddead23110ac5d356de714725', inventoryBaseline: '2f4b9959f1d4f538fffbc5def0faf8b5bc838863',
  status: 'L1/L2 修复与红绿证据完成；完整旧重分类兼容受 A1 阻塞，第2步不按全部通过结案；S05 未完成，非 S06', scenarios, runs, manifest };
const json = JSON.stringify(summary, null, 2) + '\n';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const table = `<div class="table"><table><thead><tr><th>场景</th><th>修前锁环</th><th>修前 R 行锁阻塞</th><th>修后</th><th>revision</th><th>平台预算</th><th>最终状态</th></tr></thead><tbody>${scenarios.map(row => `<tr><td>${row.name}</td><td>${row.beforeCycle ? '有：死锁失败' : '无：对照通过'}</td><td>${row.beforeRowWait ? '已观测' : '未安排探针'}</td><td>通过，无锁环</td><td>${row.revision.join(' → ')}</td><td>${row.budget.join(' → ')}</td><td>${row.status}</td></tr>`).join('')}</tbody></table></div>`;
const rawNames = ['summary.json', ...runs.flatMap(run => [run.name + '.log', run.name + '-database.json']), 'replay.json', 'fixture-errors-first.log', 'fixture-green-wrong-state.log', 'fixture-green-wrong-event.log'];
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>S05 第2步：恢复与重分类锁顺序</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.65}body{max-width:1100px;margin:32px auto;padding:0 18px}h1{font-size:1.7rem}h2{font-size:1.25rem;margin-top:2em}code,pre{font-size:.88rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:14px;background:#8881;border:1px solid #8885;border-radius:8px}table{border-collapse:collapse;width:100%;min-width:700px}td,th{text-align:left;padding:9px;border-bottom:1px solid #8885}.table{overflow:auto}details{margin:16px 0;border:1px solid #8885;border-radius:8px;padding:10px}summary{cursor:pointer;font-weight:600}p,li{overflow-wrap:anywhere}.notice{padding:16px;border-left:5px solid #b8860b;background:#b8860b12}a{color:#2879c8}
</style><body><h1>S05 第2步：恢复与重分类锁顺序</h1><p class="notice">S05 整体未完成。本页展示 L1/L2 的实际隔离数据库证据，不是 S06 独立审查，也不代表预算异常或历史退出码已归因。没有部署或恢复业务票。</p>
<p>业务改动仅两文件、五个事务：先取 graph-control，再锁 Node，随后按原逻辑更新 TaskRun/Participant 与结论。沿用 graphRunCanStartTx 取锁，不新增暂停拒绝规则。</p>
<h2>同一场景，修前失败、修后通过</h2><p>固定修前提交 <code>${summary.baseline}</code>。七组实际 SQL 死锁失败；修后 18 项通过（9 个竞争/反例 + 9 个暂停场景）。工作区失败、实施重试、运行中复核三组额外证明：修前等待控制锁的事务仍持有 TaskRun 和 Participant 行锁，修后在同一会合点不持有这些行锁。</p>${table}
<h2>复跑命令与标准</h2><pre>node scripts/replay-s05-recovery-lock-order.mjs
node scripts/sandbox-postgres-session.mjs run task-graph-recovery-lock-order
node scripts/sandbox-postgres-session.mjs run task-graph-review-lock-order task-graph-review-publication
node scripts/sandbox-postgres-session.mjs run task-graph-condition-recheck task-graph-environment-outcome task-graph-natural-blockers task-graph-preparation-recovery task-graph-execution-progress
node scripts/sandbox-postgres-session.mjs run task-graph-restart-recovery task-graph-review-restart task-graph-reclassification task-graph-admission</pre>
<p>修前驱动应退出 0：它验证内部回归退出 1、七条目标失败及十一条对照通过。锁回归、发布回归和五套要求的兼容回归均退出 0，完整日志无 P2028 或 deadlock detected。额外四套联合命令中，前两套通过；旧重分类测试在实际重分类之前进入 A1 Issue 同步并报 P2024，第四套 admission 因而另跑且通过。固定修前基线也出现相同 P2024。所有运行的 schema、服务、端口和临时目录均清理通过；不将失败命令改记为绿色。</p>
<h2>连接、入口和覆盖范围</h2><p>holder 与 contender 各自使用独立单连接 PrismaClient；第三连接读取 pg_stat_activity/pg_locks/pg_blocking_pids。三个场景另用两连接请求原 TaskRun/Participant 的 FOR UPDATE。所有生产 SQL 真正执行；代理只控制事务路由与会合，未替换锁结果。</p>
<p>恢复、复核预留、重分类、admitNode 均走实际入口。完成会话的 completeConversationTurn 前置事务仍正常运行；admission 的准备事务不计作准入会合。事务外查询、退出观察与准备读取使用全局 Prisma；本次没有调用 applyExecutionOutcome 的自定义 db 参数，因此不把它描述为所有读取都经过独立连接。</p>
<p>实施场景中复核预留是陈旧竞争者：必须以原有“no longer owns verification”结束，不能死锁或启动复核。L2 使用三个节点，真正竞争另一个节点的复核预留或 operator admission；重分类只撤回目标后继，独立 sibling 的准入保留。</p>
<p>覆盖四个 L1 事务、checkpoint 后的 decision_required / waiting_for_user / platform_retry、两种 review_retry、L2 delivery_reclassified、暂停语义、重复调用、候选与原会话标识、预算与授权。原有回归补查真实协调器死亡、模型存活/未知、退出身份变化、旧 claim/revision、双阶段复核与资源清理。</p>
<p>未穷举所有交错；未单独会合 integration_conflict 的 Git 证据子分支、每种输入组合或 acpx createRun→binder 的并发。新窄测试没有启动商业模型、真实业务票、飞书发送或 Issue 同步。TaskRun 插入/外键锁的源码核对不是全局无死锁证明。</p>
<h2>完成边界</h2><p>L1 四个事务、主要 outcome 类型、L2 多节点竞争和两处 applyReviewFailureTx 调用前提已完成本轮修复/核验。完整旧重分类兼容仍受 A1 阻塞，第2步不以局部通过宣布全部结案。A1 的对照只证明该失败先于本次改动存在，不授权本轮修它。</p><h2>待后续处理</h2><p>历史预算 actual=1 expected=0 尚未归因；首次候选 checkpoint 位于 coordinator 的实施路径。历史退出码与具体前后台时序仍未完整重放。第3步事务外观察、第4步预算、第5步整体收口不在本轮；A1/A2/A3 未实施。未来 S06 仍需固定提交独立审查。</p>
<h2>原始记录（完整嵌入，可离线查看）</h2><p>以下内容直接来自运行日志和 SQL/清理证据；上方说明不代替日志。文本日志副本只清理行尾空白；SQL/账本 JSON 不改。随机 ID、PID、提交夹具与时间保留原样。</p>${rawNames.map(name => `<details class="raw"><summary>${name}</summary><pre>${escape(name === 'summary.json' ? json : read(name))}</pre></details>`).join('')}<p>历史静态清单仍固定在 <code>${summary.inventoryBaseline}</code>；本轮不修改其哈希以掩盖业务源码变化。</p></body></html>`;
if (process.argv.includes('--check')) {
  assert.equal(read('summary.json'), json); assert.equal(read('s05-step2-lock-order.html'), html);
  console.log('PASS evidence matrix, cleanup and reproducible HTML');
} else {
  fs.writeFileSync(path.join(directory, 'summary.json'), json);
  fs.writeFileSync(path.join(directory, 's05-step2-lock-order.html'), html);
}
