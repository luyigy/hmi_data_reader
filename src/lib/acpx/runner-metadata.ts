import { prisma } from '@/lib/prisma';
import type { WatchdogConfig } from './types';

export const parseModifiedFiles = (filesModified?: string[] | null) =>
  JSON.stringify(filesModified ?? []);

export const stringifyJson = (value?: Record<string, unknown> | WatchdogConfig | object | null) =>
  value ? JSON.stringify(value) : null;

export const parseJsonObject = (value?: string | null) => {
  if (!value) {
    return {} as Record<string, unknown>;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {} as Record<string, unknown>;
  }
};
export const persistSpawnedHarnessMetadata = async (
  taskRunId: string,
  participantId: string,
  childPid: number | undefined
) => {
  if (!childPid) {
    return;
  }

  const [taskRun, participant] = await Promise.all([
    prisma.taskRun.findUnique({
      where: { id: taskRunId },
      select: { controlMetadata: true },
    }),
    prisma.taskRunParticipant.findUnique({
      where: { id: participantId },
      select: { controlMetadata: true },
    }),
  ]);

  await Promise.all([
    prisma.taskRun.update({
      where: { id: taskRunId },
      data: {
        controlMetadata: stringifyJson({
          ...parseJsonObject(taskRun?.controlMetadata),
          activeLocalHarnessPid: childPid,
          localHarnessSpawnedAt: new Date().toISOString(),
        }),
      },
    }),
    prisma.taskRunParticipant.update({
      where: { id: participantId },
      data: {
        controlMetadata: stringifyJson({
          ...parseJsonObject(participant?.controlMetadata),
          childPid,
          spawnedAt: new Date().toISOString(),
        }),
      },
    }),
  ]);
};

const persistCodexThreadMetadata = async (
  taskRunId: string,
  participantId: string,
  threadId: string | undefined
) => {
  if (!threadId) {
    return;
  }

  const [taskRun, participant] = await Promise.all([
    prisma.taskRun.findUnique({
      where: { id: taskRunId },
      select: { controlMetadata: true },
    }),
    prisma.taskRunParticipant.findUnique({
      where: { id: participantId },
      select: { controlMetadata: true },
    }),
  ]);

  const now = new Date().toISOString();
  const taskRunMetadata = parseJsonObject(taskRun?.controlMetadata);
  const participantMetadata = parseJsonObject(participant?.controlMetadata);
  const existingRunTracking =
    taskRunMetadata.sessionTracking && typeof taskRunMetadata.sessionTracking === 'object'
      ? taskRunMetadata.sessionTracking as Record<string, unknown>
      : {};
  const existingParticipantTracking =
    participantMetadata.sessionTracking && typeof participantMetadata.sessionTracking === 'object'
      ? participantMetadata.sessionTracking as Record<string, unknown>
      : {};

  await Promise.all([
    prisma.taskRun.update({
      where: { id: taskRunId },
      data: {
        controlMetadata: stringifyJson({
          ...taskRunMetadata,
          codexThreadId: threadId,
          lastSessionThreadId: threadId,
          lastSessionId: threadId,
          lastSessionKind: 'codex_thread',
          sessionTracking: {
            ...existingRunTracking,
            rootRunId:
              typeof existingRunTracking.rootRunId === 'string'
                ? existingRunTracking.rootRunId
                : taskRunId,
            latestRunId: taskRunId,
            rootThreadId:
              typeof existingRunTracking.rootThreadId === 'string'
                ? existingRunTracking.rootThreadId
                : threadId,
            rootSessionId:
              typeof existingRunTracking.rootSessionId === 'string'
                ? existingRunTracking.rootSessionId
                : threadId,
            latestThreadId: threadId,
            latestSessionId: threadId,
            latestSessionKind: 'codex_thread',
            checkedAt: now,
            sameSessionConfirmed:
              typeof existingRunTracking.rootThreadId === 'string'
                ? existingRunTracking.rootThreadId === threadId
                : true,
          },
        }),
      },
    }),
    prisma.taskRunParticipant.update({
      where: { id: participantId },
      data: {
        controlMetadata: stringifyJson({
          ...participantMetadata,
          codexThreadId: threadId,
          lastSessionThreadId: threadId,
          lastSessionId: threadId,
          lastSessionKind: 'codex_thread',
          sessionTracking: {
            ...existingParticipantTracking,
            rootParticipantId:
              typeof existingParticipantTracking.rootParticipantId === 'string'
                ? existingParticipantTracking.rootParticipantId
                : participantId,
            latestParticipantId: participantId,
            rootThreadId:
              typeof existingParticipantTracking.rootThreadId === 'string'
                ? existingParticipantTracking.rootThreadId
                : threadId,
            rootSessionId:
              typeof existingParticipantTracking.rootSessionId === 'string'
                ? existingParticipantTracking.rootSessionId
                : threadId,
            latestThreadId: threadId,
            latestSessionId: threadId,
            latestSessionKind: 'codex_thread',
            checkedAt: now,
            sameSessionConfirmed:
              typeof existingParticipantTracking.rootThreadId === 'string'
                ? existingParticipantTracking.rootThreadId === threadId
                : true,
          },
        }),
      },
    }),
  ]);
};

const persistClaudeSessionMetadata = async (
  taskRunId: string,
  participantId: string,
  sessionId: string | undefined
) => {
  if (!sessionId) {
    return;
  }

  const [taskRun, participant] = await Promise.all([
    prisma.taskRun.findUnique({
      where: { id: taskRunId },
      select: { controlMetadata: true },
    }),
    prisma.taskRunParticipant.findUnique({
      where: { id: participantId },
      select: { controlMetadata: true },
    }),
  ]);

  const now = new Date().toISOString();
  const taskRunMetadata = parseJsonObject(taskRun?.controlMetadata);
  const participantMetadata = parseJsonObject(participant?.controlMetadata);
  const existingRunTracking =
    taskRunMetadata.sessionTracking && typeof taskRunMetadata.sessionTracking === 'object'
      ? taskRunMetadata.sessionTracking as Record<string, unknown>
      : {};
  const existingParticipantTracking =
    participantMetadata.sessionTracking && typeof participantMetadata.sessionTracking === 'object'
      ? participantMetadata.sessionTracking as Record<string, unknown>
      : {};

  await Promise.all([
    prisma.taskRun.update({
      where: { id: taskRunId },
      data: {
        controlMetadata: stringifyJson({
          ...taskRunMetadata,
          claudeSessionId: sessionId,
          lastSessionId: sessionId,
          lastSessionKind: 'claude_session',
          sessionTracking: {
            ...existingRunTracking,
            rootRunId:
              typeof existingRunTracking.rootRunId === 'string'
                ? existingRunTracking.rootRunId
                : taskRunId,
            latestRunId: taskRunId,
            rootSessionId:
              typeof existingRunTracking.rootSessionId === 'string'
                ? existingRunTracking.rootSessionId
                : sessionId,
            latestSessionId: sessionId,
            latestSessionKind: 'claude_session',
            checkedAt: now,
            sameSessionConfirmed:
              typeof existingRunTracking.rootSessionId === 'string'
                ? existingRunTracking.rootSessionId === sessionId
                : true,
          },
        }),
      },
    }),
    prisma.taskRunParticipant.update({
      where: { id: participantId },
      data: {
        controlMetadata: stringifyJson({
          ...participantMetadata,
          claudeSessionId: sessionId,
          lastSessionId: sessionId,
          lastSessionKind: 'claude_session',
          sessionTracking: {
            ...existingParticipantTracking,
            rootParticipantId:
              typeof existingParticipantTracking.rootParticipantId === 'string'
                ? existingParticipantTracking.rootParticipantId
                : participantId,
            latestParticipantId: participantId,
            rootSessionId:
              typeof existingParticipantTracking.rootSessionId === 'string'
                ? existingParticipantTracking.rootSessionId
                : sessionId,
            latestSessionId: sessionId,
            latestSessionKind: 'claude_session',
            checkedAt: now,
            sameSessionConfirmed:
              typeof existingParticipantTracking.rootSessionId === 'string'
                ? existingParticipantTracking.rootSessionId === sessionId
                : true,
          },
        }),
      },
    }),
  ]);
};

const persistDeepSeekThreadMetadata = async (
  taskRunId: string,
  participantId: string,
  threadId: string | undefined
) => {
  if (!threadId) {
    return;
  }

  const [taskRun, participant] = await Promise.all([
    prisma.taskRun.findUnique({
      where: { id: taskRunId },
      select: { controlMetadata: true },
    }),
    prisma.taskRunParticipant.findUnique({
      where: { id: participantId },
      select: { controlMetadata: true },
    }),
  ]);

  const now = new Date().toISOString();
  const taskRunMetadata = parseJsonObject(taskRun?.controlMetadata);
  const participantMetadata = parseJsonObject(participant?.controlMetadata);
  const existingRunTracking =
    taskRunMetadata.sessionTracking && typeof taskRunMetadata.sessionTracking === 'object'
      ? taskRunMetadata.sessionTracking as Record<string, unknown>
      : {};
  const existingParticipantTracking =
    participantMetadata.sessionTracking && typeof participantMetadata.sessionTracking === 'object'
      ? participantMetadata.sessionTracking as Record<string, unknown>
      : {};

  await Promise.all([
    prisma.taskRun.update({
      where: { id: taskRunId },
      data: {
        controlMetadata: stringifyJson({
          ...taskRunMetadata,
          deepseekThreadId: threadId,
          lastSessionId: threadId,
          lastSessionKind: 'deepseek_thread',
          sessionTracking: {
            ...existingRunTracking,
            rootRunId:
              typeof existingRunTracking.rootRunId === 'string'
                ? existingRunTracking.rootRunId
                : taskRunId,
            latestRunId: taskRunId,
            rootSessionId:
              typeof existingRunTracking.rootSessionId === 'string'
                ? existingRunTracking.rootSessionId
                : threadId,
            latestSessionId: threadId,
            latestSessionKind: 'deepseek_thread',
            checkedAt: now,
            sameSessionConfirmed:
              typeof existingRunTracking.rootSessionId === 'string'
                ? existingRunTracking.rootSessionId === threadId
                : true,
          },
        }),
      },
    }),
    prisma.taskRunParticipant.update({
      where: { id: participantId },
      data: {
        controlMetadata: stringifyJson({
          ...participantMetadata,
          deepseekThreadId: threadId,
          lastSessionId: threadId,
          lastSessionKind: 'deepseek_thread',
          sessionTracking: {
            ...existingParticipantTracking,
            rootParticipantId:
              typeof existingParticipantTracking.rootParticipantId === 'string'
                ? existingParticipantTracking.rootParticipantId
                : participantId,
            latestParticipantId: participantId,
            rootSessionId:
              typeof existingParticipantTracking.rootSessionId === 'string'
                ? existingParticipantTracking.rootSessionId
                : threadId,
            latestSessionId: threadId,
            latestSessionKind: 'deepseek_thread',
            checkedAt: now,
            sameSessionConfirmed:
              typeof existingParticipantTracking.rootSessionId === 'string'
                ? existingParticipantTracking.rootSessionId === threadId
                : true,
          },
        }),
      },
    }),
  ]);
};

const persistGeminiSessionMetadata = async (
  taskRunId: string,
  participantId: string,
  sessionId: string | undefined
) => {
  if (!sessionId) {
    return;
  }

  const [taskRun, participant] = await Promise.all([
    prisma.taskRun.findUnique({
      where: { id: taskRunId },
      select: { controlMetadata: true },
    }),
    prisma.taskRunParticipant.findUnique({
      where: { id: participantId },
      select: { controlMetadata: true },
    }),
  ]);

  const now = new Date().toISOString();
  const taskRunMetadata = parseJsonObject(taskRun?.controlMetadata);
  const participantMetadata = parseJsonObject(participant?.controlMetadata);
  const existingRunTracking =
    taskRunMetadata.sessionTracking && typeof taskRunMetadata.sessionTracking === 'object'
      ? taskRunMetadata.sessionTracking as Record<string, unknown>
      : {};
  const existingParticipantTracking =
    participantMetadata.sessionTracking && typeof participantMetadata.sessionTracking === 'object'
      ? participantMetadata.sessionTracking as Record<string, unknown>
      : {};

  await Promise.all([
    prisma.taskRun.update({
      where: { id: taskRunId },
      data: {
        controlMetadata: stringifyJson({
          ...taskRunMetadata,
          geminiSessionId: sessionId,
          lastSessionId: sessionId,
          lastSessionKind: 'gemini_session',
          sessionTracking: {
            ...existingRunTracking,
            rootRunId:
              typeof existingRunTracking.rootRunId === 'string'
                ? existingRunTracking.rootRunId
                : taskRunId,
            latestRunId: taskRunId,
            rootSessionId:
              typeof existingRunTracking.rootSessionId === 'string'
                ? existingRunTracking.rootSessionId
                : sessionId,
            latestSessionId: sessionId,
            latestSessionKind: 'gemini_session',
            checkedAt: now,
            sameSessionConfirmed:
              typeof existingRunTracking.rootSessionId === 'string'
                ? existingRunTracking.rootSessionId === sessionId
                : true,
          },
        }),
      },
    }),
    prisma.taskRunParticipant.update({
      where: { id: participantId },
      data: {
        controlMetadata: stringifyJson({
          ...participantMetadata,
          geminiSessionId: sessionId,
          lastSessionId: sessionId,
          lastSessionKind: 'gemini_session',
          sessionTracking: {
            ...existingParticipantTracking,
            rootParticipantId:
              typeof existingParticipantTracking.rootParticipantId === 'string'
                ? existingParticipantTracking.rootParticipantId
                : participantId,
            latestParticipantId: participantId,
            rootSessionId:
              typeof existingParticipantTracking.rootSessionId === 'string'
                ? existingParticipantTracking.rootSessionId
                : sessionId,
            latestSessionId: sessionId,
            latestSessionKind: 'gemini_session',
            checkedAt: now,
            sameSessionConfirmed:
              typeof existingParticipantTracking.rootSessionId === 'string'
                ? existingParticipantTracking.rootSessionId === sessionId
                : true,
          },
        }),
      },
    }),
  ]);
};

export const persistPlatformLocalSessionMetadata = async (
  taskRunId: string,
  participantId: string,
  sessionKind: string | undefined,
  sessionId: string | undefined,
  threadId?: string
) => {
  if (sessionKind === 'codex_thread') {
    await persistCodexThreadMetadata(taskRunId, participantId, threadId || sessionId);
    return;
  }

  if (sessionKind === 'claude_session') {
    await persistClaudeSessionMetadata(taskRunId, participantId, sessionId);
    return;
  }

  if (sessionKind === 'deepseek_thread') {
    await persistDeepSeekThreadMetadata(taskRunId, participantId, threadId || sessionId);
    return;
  }

  if (sessionKind === 'gemini_session') {
    await persistGeminiSessionMetadata(taskRunId, participantId, sessionId);
    return;
  }

  if (sessionKind === 'pi_session_dir' && sessionId) {
    const [taskRun, participant] = await Promise.all([
      prisma.taskRun.findUnique({
        where: { id: taskRunId },
        select: { controlMetadata: true },
      }),
      prisma.taskRunParticipant.findUnique({
        where: { id: participantId },
        select: { controlMetadata: true },
      }),
    ]);

    const now = new Date().toISOString();
    const taskRunMetadata = parseJsonObject(taskRun?.controlMetadata);
    const participantMetadata = parseJsonObject(participant?.controlMetadata);
    const existingRunTracking =
      taskRunMetadata.sessionTracking && typeof taskRunMetadata.sessionTracking === 'object'
        ? taskRunMetadata.sessionTracking as Record<string, unknown>
        : {};
    const existingParticipantTracking =
      participantMetadata.sessionTracking && typeof participantMetadata.sessionTracking === 'object'
        ? participantMetadata.sessionTracking as Record<string, unknown>
        : {};

    await Promise.all([
      prisma.taskRun.update({
        where: { id: taskRunId },
        data: {
          controlMetadata: stringifyJson({
            ...taskRunMetadata,
            piSessionDir: sessionId,
            lastSessionId: sessionId,
            lastSessionKind: 'pi_session_dir',
            sessionTracking: {
              ...existingRunTracking,
              latestRunId: taskRunId,
              latestSessionId: sessionId,
              latestSessionKind: 'pi_session_dir',
              checkedAt: now,
            },
          }),
        },
      }),
      prisma.taskRunParticipant.update({
        where: { id: participantId },
        data: {
          controlMetadata: stringifyJson({
            ...participantMetadata,
            piSessionDir: sessionId,
            lastSessionId: sessionId,
            lastSessionKind: 'pi_session_dir',
            sessionTracking: {
              ...existingParticipantTracking,
              latestParticipantId: participantId,
              latestSessionId: sessionId,
              latestSessionKind: 'pi_session_dir',
              checkedAt: now,
            },
          }),
        },
      }),
    ]);
  }
};
