import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AcpxPermissionConfig } from './types';

export type StageAuthority = { taskRunId: string; inputIds?: string[]; inputFingerprint?: string } & (
  | { kind: 'execution'; executionId: string; claimToken: string; revision: number; phase: string;
      candidateCommit: string | null; sourceRoots: string[] }
  | { kind: 'review'; runId: string; nodeId: string; phase: 'architecture' | 'acceptance'; claimKey: string;
      candidates: { repository: string; commit: string | null }[]; sourceRoots: string[] }
  | { kind: 'conversation'; executionId: string; reservationId: string; candidateCommit: string | null });

export interface StageRuntimeContract {
  workingDirectory: string;
  workspaceRoot?: string;
  permissionConfig: AcpxPermissionConfig;
  extraReadOnlyPaths: string[];
  extraWritableRoots: string[];
  outputDirectory: string;
  outputBindings: string;
  inputManifest?: string;
}

type StageInput = { authority: StageAuthority; runtime: StageRuntimeContract };
type OutputBinding = { source: string; target: string; readOnly: boolean };

export class W001StageContractError extends Error {
  constructor(message: string) { super(`W001 Stage Execution Contract Consistency: ${message}`); this.name = 'W001StageContractError'; Object.setPrototypeOf(this, new.target.prototype); }
}

function reject(message: string): never { throw new W001StageContractError(message); }
function absolute(value: string) {
  if (!path.isAbsolute(value) || value.includes('\0') || path.normalize(value) !== value) reject('non-canonical runtime path');
}
const within = (root: string, target: string) => target === root || target.startsWith(root === path.sep ? root : root + path.sep);
const overlaps = (left: string, right: string) => within(left, right) || within(right, left);
function commit(value: string | null) {
  if (value !== null && !/^[a-f0-9]{40,64}$/.test(value)) reject('invalid candidate identity');
}
function text(value: string) { if (!value.trim()) reject('empty stage identity'); }

function bindings(serialized: string): OutputBinding[] {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { reject('invalid output bindings'); }
  if (!Array.isArray(value)) return reject('invalid output bindings');
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('source' in item) || typeof item.source !== 'string' ||
        !('target' in item) || typeof item.target !== 'string' || !('readOnly' in item) || typeof item.readOnly !== 'boolean') {
      return reject('invalid output binding');
    }
    absolute(item.source); absolute(item.target);
    return { source: item.source, target: item.target, readOnly: item.readOnly };
  });
}

function validate({ authority, runtime }: StageInput) {
  text(authority.taskRunId);
  authority.inputIds?.forEach(text);
  absolute(runtime.workingDirectory);
  if (runtime.workspaceRoot) absolute(runtime.workspaceRoot);
  absolute(runtime.outputDirectory);
  [...runtime.extraReadOnlyPaths, ...runtime.extraWritableRoots, ...runtime.permissionConfig.writableRoots].forEach(absolute);
  if (runtime.permissionConfig.sandboxMode === 'danger-full-access' || runtime.permissionConfig.profile === 'full_access') reject('unrestricted stage runtime');
  const output = bindings(runtime.outputBindings);
  if (!output.some(binding => !binding.readOnly && binding.source === runtime.outputDirectory && binding.target === runtime.outputDirectory)) {
    reject('output directory lacks its writable binding');
  }
  const sameTarget = output.filter(binding => binding.target === runtime.outputDirectory);
  if (sameTarget.length !== 1) reject('ambiguous output directory binding');
  let protectedRoots: string[] = [];
  let isolated = false;
  switch (authority.kind) {
    case 'execution':
      text(authority.executionId); text(authority.claimToken); text(authority.phase); commit(authority.candidateCommit);
      if (!Number.isSafeInteger(authority.revision) || authority.revision < 0) reject('invalid stage revision');
      authority.sourceRoots.forEach(absolute);
      if (authority.phase === 'conflict_repair') {
        if (!authority.sourceRoots.length || !authority.candidateCommit) reject('conflict repair lacks fixed source identity');
        protectedRoots = authority.sourceRoots; isolated = true;
      }
      break;
    case 'review':
      text(authority.runId); text(authority.nodeId); text(authority.claimKey);
      if (!['acceptance', 'architecture'].includes(authority.phase) || !authority.candidates.length) reject('invalid review stage');
      for (const candidate of authority.candidates) { absolute(candidate.repository); commit(candidate.commit); }
      authority.sourceRoots.forEach(absolute);
      if (!authority.sourceRoots.length) reject('review lacks readonly source roots');
      protectedRoots = authority.sourceRoots;
      isolated = runtime.permissionConfig.sandboxMode !== 'read-only';
      break;
    case 'conversation':
      text(authority.executionId); text(authority.reservationId); commit(authority.candidateCommit);
      if (runtime.permissionConfig.sandboxMode !== 'read-only') reject('conversation source is writable');
      break;
  }
  const writable = [...runtime.permissionConfig.writableRoots, ...runtime.extraWritableRoots,
    ...(runtime.permissionConfig.sandboxMode === 'workspace-write' ? [runtime.workspaceRoot || runtime.workingDirectory] : [])];
  for (const root of protectedRoots) {
    if (!runtime.extraReadOnlyPaths.some(mount => within(mount, root))) reject('stage source lacks readonly mount');
    if (isolated && within(root, runtime.workingDirectory)) reject('stage working directory is inside protected source');
    if (writable.some(mount => overlaps(root, mount))) reject('writable root overlaps protected source');
    if (output.some(binding => !binding.readOnly && overlaps(root, binding.target) &&
        !(binding.target !== root && within(root, binding.target) && within(runtime.outputDirectory, binding.source)))) {
      reject('output binding overlaps protected source without an isolated output alias');
    }
  }
}

function freeze(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

export class StageExecutionRequest {
  readonly prompt: string;
  readonly identity: string;
  private readonly snapshot: StageInput;
  private constructor(input: StageInput & { prompt: string }) {
    validate(input);
    text(input.prompt);
    this.prompt = input.prompt;
    this.snapshot = structuredClone({ authority: input.authority, runtime: input.runtime });
    freeze(this.snapshot);
    this.identity = createHash('sha256').update(JSON.stringify(canonical({ ...this.snapshot, prompt: this.prompt }))).digest('hex');
    Object.freeze(this);
  }
  static create(input: StageInput & { prompt: string }): StageExecutionRequest { return new StageExecutionRequest(input); }
  assertMatches(input: StageInput): void {
    validate(input);
    if (!isDeepStrictEqual(input.authority, this.snapshot.authority)) reject('stage authority drift');
    if (!isDeepStrictEqual(input.runtime, this.snapshot.runtime)) reject('stage runtime drift');
  }
}
