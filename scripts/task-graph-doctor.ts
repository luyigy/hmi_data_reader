import { loadEnvConfig } from '@next/env';
import { prisma } from '../src/lib/prisma';
import { executionProgress } from '../src/lib/task-graph/execution-progress';
import { observeExecutionWriter } from '../src/lib/task-graph/phase-worker';
import { scheduleImplementationRecovery } from '../src/lib/task-graph/implementation-result';
import { graphFailureSummary } from '../src/lib/task-graph/failure-summary';
import { redactSensitiveText } from '../src/lib/redact-sensitive';
import { realpath } from 'node:fs/promises';
import { diagnoseTaskGraphRun } from '../src/lib/task-graph/run-doctor';

loadEnvConfig(process.cwd());

async function main() {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  let resume = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--resume' && !resume) { resume = true; continue; }
    if (!['--run-id', '--node-key', '--request-id'].includes(key) || options.has(key) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('用法：--run-id <Run> --node-key <Slice> [--resume --request-id <唯一请求标识>]');
    options.set(key, args[++index]);
  }
  const runId = options.get('--run-id'), nodeKey = options.get('--node-key'), requestId = options.get('--request-id');
  if (!runId || resume && (!nodeKey || !requestId || !/^[A-Za-z0-9:._-]{1,200}$/.test(requestId))) throw new Error('检查须指定Run；省略node-key检查全图。恢复须同时指定node-key和唯一request-id。');
  if (!nodeKey) {
    if (requestId) throw new Error('只读Run诊断不接受request-id；恢复须指定node-key。');
    console.log(redactSensitiveText(JSON.stringify(await diagnoseTaskGraphRun(runId), null, 2)));
    return;
  }
  const node = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } }, include: { executions: true } });
  const dependencies = await prisma.taskGraphNode.findMany({ where: { runId, key: { in: node.dependsOn } }, select: { key: true, status: true } });
  const jobs = await Promise.all(node.executions.map(async job => {
    const progress = executionProgress(job.dispatchMetadata);
    const taskRun = job.taskRunId ? await prisma.taskRun.findUnique({ where: { id: job.taskRunId }, select: { id: true, status: true } }) : null;
    return { id: job.id, status: job.status, phase: progress?.phase, state: progress?.state,
      candidateCommit: progress?.candidateCommit, integratedCommit: job.commit,
      workspace: job.worktreePath ? await realpath(job.worktreePath).catch(() => null) : null,
      taskRun, writer: await observeExecutionWriter(job),
      lastFailure: progress?.lastFailure ? graphFailureSummary(progress.lastFailure, progress.state) : null };
  }));
  const report = { checkedAt: new Date().toISOString(), runId, nodeKey, status: node.status, dependencies, jobs,
    scope: '默认只读；--resume只申请接续实施，保留原预算和候选，不清理目录，不代表材料齐备或验收通过。' };
  console.log(redactSensitiveText(JSON.stringify(report, null, 2)));
  if (!resume || !requestId) return;
  if (dependencies.length !== node.dependsOn.length || dependencies.some(item => !['passed', 'delivered_unverified'].includes(item.status))) throw new Error('前置交付未满足，不能恢复实施');
  const receipt = await scheduleImplementationRecovery(runId, nodeKey, `local-operator:${requestId}`);
  const current = await prisma.taskGraphNode.findUniqueOrThrow({ where: { runId_key: { runId, key: nodeKey } }, select: { status: true } });
  console.log(JSON.stringify({ result: receipt.kind, eventId: receipt.eventId, status: current.status, requestId,
    note: receipt.kind === 'already_scheduled' ? '此标识的历史请求已受理，本次未重新派发。若任务再次暂停，先修复新卡点，再用新请求标识。'
      : '已登记到既有协调器；ready不等于running，仍须核对新TaskRun和实际进程。' }));
}
main().catch(error => { console.error(redactSensitiveText(error instanceof Error ? error.message : String(error))); process.exitCode = 1; }).finally(() => prisma.$disconnect());
