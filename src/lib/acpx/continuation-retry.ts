import { executeAcpxTaskRun } from '@/lib/acpx/runner';
import { markParticipantContinuationStale } from '@/lib/acpx/session-tracking';
import type { AcpxParticipantRequest, AcpxRunRequest } from '@/lib/acpx/types';

const INVALID_CLAUDE_CONTINUATION_PATTERNS = [
  /No conversation found with session ID/i,
  /403.*forbidden|forbidden.*403|Request not allowed/i,
  /Failed to authenticate/i,
];

const INVALID_CODEX_CONTINUATION_PATTERNS = [
  /(session|thread|conversation).*(not found|does not exist|invalid)/i,
  /resume.*(failed|error)/i,
  /stream disconnected/i,
  /connection.*closed/i,
  /timed out after \d+ms/i,
  /timeout waiting for child process to exit/i,
  /failed to refresh available models/i,
];

const INVALID_DEEPSEEK_CONTINUATION_PATTERNS = [
  /thread not found/i,
  /turn .* failed/i,
];

const isInvalidContinuationError = (participant: AcpxParticipantRequest, message: string) => {
  const patterns =
    participant.harnessType === 'claude'
      ? INVALID_CLAUDE_CONTINUATION_PATTERNS
      : participant.harnessType === 'codex'
      ? INVALID_CODEX_CONTINUATION_PATTERNS
      : participant.harnessType === 'deepseek'
      ? INVALID_DEEPSEEK_CONTINUATION_PATTERNS
      : [];

  return patterns.some((pattern) => pattern.test(message));
};

const shouldRetryWithFreshSession = (participant: AcpxParticipantRequest, message: string) => {
  const hasContinuation = Boolean(participant.resumeSessionId || participant.resumeThreadId);
  return hasContinuation && isInvalidContinuationError(participant, message);
};

const stripContinuation = (participant: AcpxParticipantRequest): AcpxParticipantRequest => ({
  ...participant,
  resumeSessionId: undefined,
  continuationSessionKind: undefined,
  resumeThreadId: undefined,
});

export const executeAcpxTaskRunWithContinuationFallback = async ({
  request,
  staleParticipantId,
}: {
  request: AcpxRunRequest;
  staleParticipantId?: string | null;
}) => {
  const firstResult = await executeAcpxTaskRun(request);

  if (request.participants.length !== 1) {
    return firstResult;
  }

  const firstParticipant = request.participants[0];
  const firstParticipantResult = firstResult.participants[0];
  const firstFailureMessage =
    firstParticipantResult?.status === 'failed' ? firstParticipantResult.error || 'ACPX continuation failed' : null;

  const shouldRetry = firstFailureMessage
    ? shouldRetryWithFreshSession(firstParticipant, firstFailureMessage)
    : false;

  if (firstFailureMessage && (firstParticipant.resumeSessionId || firstParticipant.resumeThreadId)) {
    console.log('[ACPX Continuation Fallback] first attempt failed', {
      harnessType: firstParticipant.harnessType,
      role: firstParticipant.role,
      usedResumeSession: Boolean(firstParticipant.resumeSessionId),
      usedResumeThread: Boolean(firstParticipant.resumeThreadId),
      shouldRetry,
      message: firstFailureMessage,
    });
  }

  if (!firstFailureMessage || !shouldRetry) {
    return firstResult;
  }

  if (staleParticipantId) {
    await markParticipantContinuationStale({
      participantId: staleParticipantId,
      reason: firstFailureMessage,
    });
  }

  console.log('[ACPX Continuation Fallback] retrying with fresh session', {
    harnessType: firstParticipant.harnessType,
    role: firstParticipant.role,
    staleParticipantId: staleParticipantId || null,
  });

  return executeAcpxTaskRun({
    ...request,
    participants: [stripContinuation(firstParticipant)],
  });
};
