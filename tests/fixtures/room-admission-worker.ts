import { prisma } from '../../src/lib/prisma';
import { getHarnessAdapter } from '../../src/lib/harness';
import { executeLiveRoomReplyViaAcpx } from '../../src/lib/live-room-delivery-execution';
import { executeAcpxTaskRun } from '../../src/lib/acpx/runner';

require('../../src/lib/live-room-progress').attachLiveRoomProgress = async () => ({ streamCallbacks: {}, dispose: async () => {} });
require('../../src/lib/feishu-live-room-relay').relayLiveRoomMessageToFeishu = async () => {};
require('../../src/lib/feishu-turn-card').prepareRoomTurnCard = async () => null;
require('../../src/lib/scheduled-jobs/runner').wakeWorkflowWatcherForTaskRun = async () => false;
async function harnessResult(native?: string) {
  process.send?.({ kind: 'started', native });
  const action = await new Promise<string>(resolve => process.once('message', (message: { action: string }) => resolve(message.action)));
  return { success: action !== 'fail', output: 'fixture reply', error: action === 'fail' ? 'fixture failure' : undefined, executionTime: 1,
    sessionId: native || `native-${process.argv[2]}`, sessionKind: 'generic_session' };
}
for (const type of ['kimi-code', 'pi-agent', 'codex']) {
  const adapter = getHarnessAdapter(type)!;
  adapter.execute = async () => harnessResult();
  adapter.resume = async args => harnessResult(args.sessionId);
}
// Only transport/LLM leaves are substituted. Room dispatch, Runner, TaskRun and DB transactions are real.
require('../../src/lib/remote-harness/hosts').getRemoteHarnessHostById = async (id: string) => ({ id, label: 'WPI fixture', supportedHarnesses: ['pi-agent'] });
require('../../src/lib/remote-harness/ssh-executor').executeRemoteSshTask = async (_task: unknown, options: { resumeSessionId?: string }) => {
  const result = await harnessResult(options.resumeSessionId);
  if (!result.success) throw new Error(result.error);
  return { ...result, filesModified: [], liveStreaming: false };
};
async function main() {
  if (process.argv[3]) {
    const request = JSON.parse(process.argv[3]);
    if (request.fixtureDispatch) {
      const delivery = await prisma.liveRoomDelivery.findUniqueOrThrow({ where: { id: process.argv[2] }, include: { roomMessage: true } });
      const { processLiveRoomDelivery } = await import('../../src/lib/live-room-delivery-processing');
      await processLiveRoomDelivery({ deliveryId: delivery.id, roomId: delivery.roomMessage.roomId,
        roomMessageId: delivery.roomMessageId, targetMemberId: delivery.targetMemberId, chainDepth: 0 });
      const result = await prisma.liveRoomDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      if (result.deliveryStatus === 'failed') throw new Error(result.fallbackReason || 'delivery failed');
      process.send?.({ kind: 'done' });
      return;
    }
    if (request.fixtureFailOnStart) request.streamCallbacks = { onRunStarted: async () => { throw new Error('fixture startup failure'); } };
    delete request.fixtureFailOnStart;
    const result = await executeAcpxTaskRun(request);
    process.send?.({ kind: 'done', status: result.status });
    return;
  }
  const delivery = await prisma.liveRoomDelivery.findUniqueOrThrow({ where: { id: process.argv[2] }, include: {
    targetMember: { include: { gateway: true, agentRecord: true } }, session: true,
    roomMessage: { include: { senderMember: true, room: { include: { members: { include: { gateway: true, agentRecord: true } } } } } },
  } });
  await executeLiveRoomReplyViaAcpx({ room: delivery.roomMessage.room, sourceMessage: delivery.roomMessage,
    targetMember: delivery.targetMember, session: delivery.session!, deliveryId: delivery.id } as Parameters<typeof executeLiveRoomReplyViaAcpx>[0]);
  process.send?.({ kind: 'done' });
}
main().catch(error => process.send?.({ kind: 'error', error: error.message })).finally(async () => { await prisma.$disconnect(); process.disconnect?.(); });
