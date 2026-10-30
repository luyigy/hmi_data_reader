export type HistoryHarness = 'codex' | 'kimi-code' | 'pi-agent' | 'antigravity';
export type HistorySource = { harness: HistoryHarness; home: string; label: string };
export type HistoryFile = { relative: string; identity: string; bytes: number; mtime: number; ctime: number };
export type HistoryRecord = {
  key: string; harness: HistoryHarness; nativeId: string; home: string; location: string;
  label: string; project: string | null; bytes: number | null; lastActivity: number | null;
  files: HistoryFile[]; fingerprint: string; issues: string[];
};
export type HistoryReference = {
  nativeId: string; harness: string; participantId: string; taskId: string; taskName: string;
  lastActivity: number; protected: boolean; reasons: string[];
};
export type HistoryRow = Omit<HistoryRecord, 'files' | 'fingerprint' | 'issues'> & {
  state: 'retained' | 'protected' | 'eligible' | 'unknown'; reasons: string[];
  references: Array<{ taskId: string; taskName: string }>; fileCount: number;
};
export type HistoryInventory = {
  sampledAt: number; rows: HistoryRow[]; sources: Array<HistorySource & { status: string; count: number; error?: string }>;
  truncated: boolean; unsupported: string[];
};
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const normalizeNativeId = (harness: string, id: string) => harness === 'kimi-code' ? id.replace(/^session_/, '') : id;
