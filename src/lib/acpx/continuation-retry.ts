import { executeAcpxTaskRun } from '@/lib/acpx/runner';
import { getHarnessAdapter } from '@/lib/harness';
import { markParticipantContinuationStale } from '@/lib/acpx/session-tracking';
import type { AcpxParticipantRequest, AcpxRunRequest } from '@/lib/acpx/types';

const isInvalidContinuationError = (participant: AcpxParticipantRequest, message: string) => {
  return getHarnessAdapter(participant.harnessType)?.isInvalidContinuationError?.(message) ?? false;
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
