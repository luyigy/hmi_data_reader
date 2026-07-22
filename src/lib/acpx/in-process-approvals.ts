type ApprovalDecision = 'approve' | 'deny';
type ApprovalResult = { decision: ApprovalDecision; timedOut: boolean };

const pending = new Map<string, (result: ApprovalResult) => void>();

export const waitForInProcessApproval = (requestId: string, timeoutMs = 10 * 60 * 1000) =>
  new Promise<ApprovalResult>((resolve) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      resolve({ decision: 'deny', timedOut: true });
    }, timeoutMs);
    pending.set(requestId, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });
  });

export const resolveInProcessApproval = (requestId: string, decision: ApprovalDecision) => {
  const resolve = pending.get(requestId);
  if (!resolve) return false;
  pending.delete(requestId);
  resolve({ decision, timedOut: false });
  return true;
};

export const cancelInProcessApproval = (requestId: string) => {
  pending.delete(requestId);
};
