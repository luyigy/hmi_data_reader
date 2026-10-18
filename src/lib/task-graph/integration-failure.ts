export type IntegrationConflict = {
  kind: 'conflict';
  candidateCommit: string;
  integrationCommit: string;
  mergeHead: string | null;
  paths: string[];
};

export type IntegrationStale = {
  kind: 'stale';
  candidateCommit: string;
  expectedIntegrationCommit: string;
  integrationCommit: string;
};

export type IntegrationFailure = IntegrationConflict | IntegrationStale | {
  kind: 'ownership_mismatch';
  candidateCommit: string;
  integrationCommit: string;
  detail: string;
} | {
  kind: 'retry_exhausted';
  attempts: number;
  lastFailure: IntegrationStale;
};
