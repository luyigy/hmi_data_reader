import { lstat } from 'node:fs/promises';
import type { HarnessAdapter, HarnessExecuteArgs } from './types';
import { withNativeSessionSize, type NativeSessionBytes } from '../real-agents/native-session-size';

/** Wrap the native adapter boundary, retaining the Runner's execution/session fencing. */
export function withSessionSizeAdapter(adapter: HarnessAdapter, options: {
  read: (id: string, args: HarnessExecuteArgs) => Promise<NativeSessionBytes | null>;
  initialSessionId?: (args: HarnessExecuteArgs) => string;
}): HarnessAdapter {
  const track = async (args: HarnessExecuteArgs, sessionId: string | undefined, fresh: boolean,
    run: (args: HarnessExecuteArgs) => ReturnType<HarnessAdapter['execute']>) => {
    const context = args.context;
    if (!context.executionId || !context.onSessionSize || context.ephemeralSession || context.executionBackend !== 'platform_local') return run(args);
    if (fresh && sessionId) {
      // Pi can reuse a directory even on execute; an unreadable baseline is not an empty history.
      try { await lstat(sessionId); fresh = false; }
      catch (error) { fresh = (error as NodeJS.ErrnoException).code === 'ENOENT'; }
    }
    return withNativeSessionSize({ executionId: context.executionId, sessionId, fresh,
      ephemeral: context.ephemeralSession || context.executionBackend !== 'platform_local',
      read: id => options.read(id, args), onSample: context.onSessionSize }, async bind => {
      const onSessionStarted: NonNullable<typeof context.onSessionStarted> = async session => {
        await context.onSessionStarted?.(session);
        await bind(session.sessionId);
      };
      return run({ ...args, context: { ...context, onSessionStarted } });
    });
  };
  return { ...adapter,
    execute: args => track(args, options.initialSessionId?.(args), true, next => adapter.execute(next)),
    resume: adapter.resume ? args => track(args, args.sessionId, false,
      next => adapter.resume!({ ...args, context: next.context })) : undefined,
  };
}
