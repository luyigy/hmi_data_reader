import assert from 'node:assert/strict';
import { parseResourceRequest, submitRunnerResourceRequest } from '../src/lib/task-resources/runner-protocol';
import { prisma } from '../src/lib/prisma';

async function main() {
  const value = { purpose: '读取相邻仓库', resources: [{ path: '/tmp/fixture', access: 'read' }] };
  const command = `<resource-request>${JSON.stringify(value)}</resource-request>`;
  const explanations = [
    '现在资源申请仍通过最终答复里的 `<resource-request>` 解析，交付也有文本标记。这只是过渡实现。',
    '`<resource-request>`',
    '缺少结束标记：<resource-request>',
    '<resource-request> 是旧协议中的申请标记。',
    `例如：${command}`,
    '```xml\n' + command + '\n```',
    '> ' + command,
    command + '\n上面只是一个示例。',
    command + '\n上面示例结束于 </resource-request>',
    `解释协议：\n${command}\n这不是真实申请。`,
  ];
  for (const explanation of explanations) assert.equal(parseResourceRequest(explanation), null);
  assert.deepEqual(parseResourceRequest(' \n' + command + '\n '), value);
  assert.deepEqual(parseResourceRequest('<resource-request>\n' + JSON.stringify(value, null, 2) + '\n</resource-request>'), value);
  assert.throws(() => parseResourceRequest('<resource-request>{"purpose":"truncated"}'), /缺少结束标记/);
  assert.throws(() => parseResourceRequest(command + '\n' + command), /每轮只能/);
  assert.throws(() => parseResourceRequest('<resource-request>{broken}</resource-request>'));
  assert.throws(() => parseResourceRequest(`<resource-request>${JSON.stringify({ ...value, requester: 'invented' })}</resource-request>`));
  const original = prisma.taskRun.findUniqueOrThrow;
  prisma.taskRun.findUniqueOrThrow = (async () => ({ controlMetadata: '{}' })) as unknown as typeof original;
  try {
    for (const output of explanations) {
      assert.equal(await submitRunnerResourceRequest({ output, taskRunId: 'fixture', participantId: 'fixture',
        request: { taskId: 'fixture', taskName: 'fixture', orchestrationMode: 'single', participants: [] },
        participant: { gatewayId: 'local', executionBackend: 'platform_local', harnessType: 'codex', role: 'custom' },
      }), output, 'ordinary explanations survive the runner completion path unchanged');
    }
  } finally { prisma.taskRun.findUniqueOrThrow = original; }
  console.log('Resource protocol: quoted markers and examples stay conversational; standalone requests still validate; completion preserves explanations');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
