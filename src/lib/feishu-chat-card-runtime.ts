import { relayPendingTurnCards } from './feishu-turn-card';
import { PROGRESS_CARD_MIN_MS } from './acpx/harness-events';

/** Chat owns recovery even when no task graph worker is running. */
export function startChatCardRecovery(prefix: string) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void>;
  const tick = () => {
    pending = relayPendingTurnCards()
      .catch(error => console.error(`${prefix} chat card recovery failed:`, error))
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(tick, PROGRESS_CARD_MIN_MS);
          timer.unref();
        }
      });
  };
  tick();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await pending;
  };
}
