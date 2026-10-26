import type { AcceptanceReceipt } from './acceptance-evidence';
import { createHash } from 'node:crypto';
import { executeAcpxTaskRun, AcpxRunStartupError } from '../acpx/runner';
import type { AcpxRunRequest } from '../acpx/types';
import { assertGraphReviewOwnership, completedGraphReviewTaskRun } from './review-ownership';
import { prisma } from '../prisma';
import { classifyReview, type ClassifiedReview, type ReviewCheck } from './review-contract';

type CollectedReview =
  | { kind: 'classified'; decision: ClassifiedReview; verification?: AcceptanceReceipt; taskRunId: string }
  | { kind: 'protocol_exhausted' | 'platform_failure'; note: string; taskRunId: string };

/** One bounded result recollection; a missing/unknown result never becomes an approval. */
export async function collectGraphReview(args: {
  runId: string; nodeId: string; claimKey: string; marker: string; checks: ReviewCheck[]; request: AcpxRunRequest;
  validateVerification?: (value: unknown, approved: boolean) => value is AcceptanceReceipt;
}): Promise<CollectedReview> {
  const key = createHash('sha256').update(args.claimKey).digest('hex').slice(0, 24);
  const previous = await prisma.taskGraphEvent.findMany({ where: { runId: args.runId, idempotencyKey: { in: [`review-result:${key}:0`, `review-result:${key}:1`] } } });
  const exhausted = previous.find(event => event.kind === 'review_result_exhausted');
  if (exhausted && exhausted.payload && typeof exhausted.payload === 'object' && !Array.isArray(exhausted.payload) && typeof exhausted.payload.taskRunId === 'string') return { kind: 'protocol_exhausted', note: '本次复核格式补收已耗尽，保留交付与原始返回', taskRunId: exhausted.payload.taskRunId };
  const recollection = previous.find(event => event.kind === 'review_result_recollection');
  let savedId = args.request.graphReview ? await completedGraphReviewTaskRun(args.nodeId, args.request.graphReview.phase, args.claimKey) : null;
  const priorTaskRunId = recollection?.payload && typeof recollection.payload === 'object' && !Array.isArray(recollection.payload) ? recollection.payload.taskRunId : null;
  const feedbackFor = (response: string) => `\n本次仅补收复核结论，不重复修改代码。上次返回没有有效结构化结果、固定版本逐项检查回执、稳定检查 ID 或执行归属。根据实际已完成的复核和提供的 ID 重发一行结论，不得合成通过。上次返回：${response.slice(-8000)}`;
  const priorResponse = recollection?.payload && typeof recollection.payload === 'object' && !Array.isArray(recollection.payload) && typeof recollection.payload.response === 'string' ? recollection.payload.response : '';
  let feedback = recollection ? feedbackFor(priorResponse) : '';
  for (let attempt = recollection ? 1 : 0; attempt < 2; attempt++) {
    const savedResultId = savedId && savedId !== priorTaskRunId ? savedId : null;
    savedId = null;
    const saved = savedResultId ? await prisma.taskRun.findUniqueOrThrow({ where: { id: savedResultId }, include: { participants: true } }) : null;
    const result = saved ? { status: saved.status, taskRunId: saved.id, participants: saved.participants, summary: saved.summary } : await executeAcpxTaskRun({ ...args.request, taskDescription: (args.request.taskDescription || '') + feedback })
      .catch(error => ({ status: 'failed', taskRunId: error instanceof AcpxRunStartupError ? error.taskRunId : 'not-created', participants: [], summary: String(error) }));
    const response = result.participants[0]?.summary || result.summary || '';
    if (args.request.graphReview && result.taskRunId !== 'not-created') await assertGraphReviewOwnership(args.nodeId, args.request.graphReview.phase, args.claimKey, result.taskRunId);
    if (result.status !== 'completed' && !['failed', 'cancelled', 'interrupted'].includes(result.status)) throw new Error('Reviewer has not reached a terminal state');
    if (result.status !== 'completed') return { kind: 'platform_failure', note: response || '复核进程没有正常结束', taskRunId: result.taskRunId };
    const match = response.match(new RegExp(args.marker + '\\s*(\\{[^\\r\\n]+\\})'));
    let raw: unknown;
    try { raw = match ? JSON.parse(match[1]) : null; } catch { raw = null; }
    const decision = classifyReview(raw, args.checks);
    const verification = raw && typeof raw === 'object' && 'verification' in raw ? raw.verification : undefined;
    const verified = args.validateVerification?.(verification, decision?.approved === true);
    const valid = !args.validateVerification || (decision?.approved === false && ['blocked_require_human', 'environment_failed'].includes(decision.failureKind)) || verified;
    if (decision && valid) return { kind: 'classified', decision, ...(verified ? { verification: verification as AcceptanceReceipt } : {}), taskRunId: result.taskRunId };
    await prisma.taskGraphEvent.createMany({ data: [{ runId: args.runId, nodeId: args.nodeId,
      idempotencyKey: `review-result:${key}:${attempt}`, kind: attempt ? 'review_result_exhausted' : 'review_result_recollection',
      payload: { claimKey: args.claimKey, taskRunId: result.taskRunId, attempt, response: response.slice(-8000), reason: 'Missing result, invalid fixed-version verification receipt, unknown check ID or invalid execution attribution' } }], skipDuplicates: true });
    if (attempt) return { kind: 'protocol_exhausted', note: '补收一次后仍无有效复核结论或执行归属，保留交付并升级协议故障', taskRunId: result.taskRunId };
    feedback = feedbackFor(response);
  }
  throw new Error('Review result loop did not terminate');
}
