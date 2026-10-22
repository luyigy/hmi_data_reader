export function transientPlatformCode(error: unknown): string | null {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    const code = 'code' in error ? error.code : 'errorCode' in error ? error.errorCode : undefined;
    if (typeof code === 'string' && ['P2028', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034'].includes(code)) return code;
    error = error.cause;
  }
  return null;
}
