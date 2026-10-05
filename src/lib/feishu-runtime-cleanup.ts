import { prisma } from '@/lib/prisma';
import { sendFeishuTextMessage } from '@/lib/feishu-api';
import { getLiveRoomRunningProcess, hasLiveRoomMemberExecution } from '@/lib/live-room-process-registry';
import { resolveRunningDeliveryStaleAfterMs } from '@/lib/live-room-execution-timeout';

export function buildFeishuRuntimeRecoveryCommand(content: string) {
  const plan = content.match(/docs\/\d+_PLAN_[^\s`]+\.md/)?.[0];
  const handover = Array.from(content.matchAll(/docs\/\d+_HANDOVER_[^\s`]+\.md/g)).at(-1)?.[0];
  const slice = content.match(/的 (S\d{2,})/)?.[1];
  return plan && handover && slice
    ? `/ap chat 重新执行 ${plan} 的 ${slice}；严格读取 ${handover} 中的 WORKFLOW_PROMPT 并执行，完成后提交并停止。`
    : '/ap chat 继续执行刚才因服务中断而停止的任务；先检查并保护现有未提交改动，完成后提交并停止。';
}

export async function failAndNotifyInterruptedDeliveries(reason: string) {
  const deliveries = await prisma.liveRoomDelivery.findMany({
    where: { deliveryStatus: 'running' },
    select: {
      id: true,
      targetMember: {
        select: { displayName: true, userNickname: true },
      },
      roomMessage: {
        select: {
          content: true,
          room: {
            select: {
              feishuBindings: {
                orderBy: { updatedAt: 'desc' },
                take: 1,
                select: { chatId: true },
              },
            },
          },
        },
      },
    },
  });
  if (!deliveries.length) return 0;
  await prisma.liveRoomDelivery.updateMany({
    where: { id: { in: deliveries.map(({ id }) => id) } },
    data: { deliveryStatus: 'failed', fallbackReason: reason, acknowledgedAt: new Date() },
  });
  await Promise.all(deliveries.map(async (delivery) => {
    const chatId = delivery.roomMessage.room.feishuBindings[0]?.chatId;
    if (!chatId) return;
    const member = delivery.targetMember.userNickname || delivery.targetMember.displayName;
    await sendFeishuTextMessage({
      receiveId: chatId,
      receiveIdType: 'chat_id',
      text: [
        `⚠️ 系统提示：服务中断或重启已停止 ${member} 的当前运行。`,
        `恢复命令：${buildFeishuRuntimeRecoveryCommand(delivery.roomMessage.content)}`,
        '请等待服务恢复后再发送；系统不会自动复用已结束的旧进程。',
      ].join('\n'),
    }).catch((error) => console.warn('[FeishuRuntime] failed to send recovery notice:', error));
  }));
  return deliveries.length;
}

/** Start a periodic watchdog that reclaims deliveries stuck in 'running' past their
 *  room's effective execution timeout plus grace. Platform Local (codex/claude/kimi-code)
 *  deliveries with a still-alive process are skipped.
 *  Only members of deliveries confirmed stale are reclaimed — not all busy members. */
export function startPeriodicWatchdog(prefix: string) {
  const interval = setInterval(async () => {
    try {
      const runningDeliveries = await prisma.liveRoomDelivery.findMany({
        where: { deliveryStatus: 'running' },
        select: {
          id: true,
          targetMemberId: true,
          attemptedAt: true,
          targetMember: {
            select: { backend: true, harnessType: true },
          },
          roomMessage: {
            select: {
              room: {
                select: { executionTimeoutMs: true },
              },
            },
          },
        },
      });
      if (runningDeliveries.length === 0) return;

      const isPlatformLocal = (delivery: typeof runningDeliveries[number]) =>
        delivery.targetMember.backend === 'platform_local';

      // The reclaim threshold is per delivery: the owning room's effective execution
      // timeout (explicit value or the 10-minute remote default) plus grace. Deliveries
      // whose room configured a longer timeout must not be reaped at the old 12-minute
      // mark while their process is still running.
      const staleDeliveries = runningDeliveries.filter((delivery) =>
        Date.now() - delivery.attemptedAt.getTime()
          >= resolveRunningDeliveryStaleAfterMs(delivery.roomMessage?.room?.executionTimeoutMs));
      if (staleDeliveries.length === 0) return;

      const trulyStale: typeof staleDeliveries = [];
      for (const delivery of staleDeliveries) {
        if (isPlatformLocal(delivery) && hasLiveRoomMemberExecution(delivery.targetMemberId)) continue;
        const process = getLiveRoomRunningProcess(delivery.targetMemberId);
        if (!process) {
          trulyStale.push(delivery);
          continue;
        }
        // Platform Local: if the process is still registered, it's still alive — skip.
        if (isPlatformLocal(delivery)) continue;
        // Non-Platform-Local: check if the process has exited.
        if (process.child.exitCode !== null || process.child.signalCode !== null) {
          trulyStale.push(delivery);
        }
      }

      if (trulyStale.length === 0) return;

      await prisma.liveRoomDelivery.updateMany({
        where: { id: { in: trulyStale.map((d) => d.id) } },
        data: { deliveryStatus: 'failed', fallbackReason: 'Stale: watchdog timeout', acknowledgedAt: new Date() },
      });

      // Only reclaim members of deliveries confirmed stale.
      const failedMemberIds = Array.from(new Set(trulyStale.map((d) => d.targetMemberId)));
      await prisma.liveRoomMember.updateMany({
        where: { id: { in: failedMemberIds }, presenceStatus: 'busy' },
        data: { presenceStatus: 'idle' },
      });

      const skipped = staleDeliveries.length - trulyStale.length;
      console.warn(`${prefix} watchdog reaped ${trulyStale.length} stale deliveries`
        + (skipped > 0 ? ` (${skipped} skipped, still alive)` : ''));
    } catch (watchdogError) {
      console.warn(`${prefix} watchdog error (non-fatal):`, watchdogError);
    }
  }, 5 * 60 * 1000);
  interval.unref();
  return interval;
}
