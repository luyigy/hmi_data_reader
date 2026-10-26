import { isDeepStrictEqual } from 'node:util';
import type { GraphNode } from './domain';

export type AcceptanceReceipt = {
  inputs: { executionId: string; commit: string | null }[];
  commits: { repository: string; commit: string }[];
  checks: { id: string; argv: string[]; exitCode: number; log: string; environmentFingerprint: string }[];
};
export function acceptanceCommands(node: GraphNode) {
  return [
    ...node.executions.flatMap(job => ((job.launchConfig as { checks?: { name: string; argv: string[] }[] })?.checks || []).map(check => ({
      id: `execution:${encodeURIComponent(job.key)}:${encodeURIComponent(check.name)}`, repository: job.repository, argv: check.argv,
    }))),
    ...(node.acceptance.integrationChecks || []).map(check => ({
      id: `integration:${encodeURIComponent(check.repository)}:${encodeURIComponent(check.name)}`, repository: check.repository, argv: check.argv,
    })),
  ];
}

/** Verify completeness and version binding, not the truth of an Agent's business-test assertion. */
export function validAcceptanceReceipt(value: unknown, node: GraphNode, inputs: AcceptanceReceipt['inputs'], commits: AcceptanceReceipt['commits'], approved: boolean): value is AcceptanceReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as AcceptanceReceipt;
  const expected = acceptanceCommands(node);
  if (!isDeepStrictEqual(receipt.inputs, inputs) || !isDeepStrictEqual(receipt.commits, commits) ||
      !Array.isArray(receipt.checks) || receipt.checks.length !== expected.length ||
      new Set(receipt.checks.map(check => check?.id)).size !== expected.length) return false;
  return expected.every(command => {
    const check = receipt.checks.find(item => item?.id === command.id);
    return check && isDeepStrictEqual(check.argv, command.argv) && Number.isInteger(check.exitCode) &&
      (!approved || check.exitCode === 0) && typeof check.log === 'string' && !!check.log.trim() &&
      typeof check.environmentFingerprint === 'string' && /^[a-f0-9]{64}$/.test(check.environmentFingerprint);
  });
}

export function acceptanceReceiptInstructions(node: GraphNode, inputs: AcceptanceReceipt['inputs'], commits: AcceptanceReceipt['commits']) {
  return `\n其他模型独立验收：${JSON.stringify(node.acceptance.models)}。实际执行以下批准命令，平台不会再跑业务检查：${JSON.stringify(acceptanceCommands(node))}` +
    `\n在 TASK_GRAPH_REVIEW JSON 增加 verification 字段：${JSON.stringify({ inputs, commits, checks: acceptanceCommands(node).map(command => ({ id: command.id, argv: command.argv, exitCode: '实际退出码（数字）', log: '实际日志位置及摘要；不得包含凭据', environmentFingerprint: '实际环境描述的 SHA256（64位小写十六进制）' })) })}。逐项如实填写，不能省略失败项；未能执行时返回 blocked_require_human 并说明原因，不得批准。inputs/commits 必须与给定固定版本完全一致。哈希仅表示一致性，平台不据此声称亲自验证业务正确性。`;
}
