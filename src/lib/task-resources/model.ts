import { createHash } from 'node:crypto';
import { realpath, stat, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import type { AcpxRunRequest } from '../acpx/types';

export type ResourceInput = { path: string; access: 'read' | 'write' };
export type ResourceDirectory = ResourceInput & { canonicalPath: string; device: string; inode: string };
export type ResourceLaunch = Omit<AcpxRunRequest, 'streamCallbacks'>;
export type ResourceSource = { taskRunId: string; participantId: string };
export type ResourceApplication = { state: 'waiting' | 'scheduled' | 'effective' | 'failed' | 'revoking' | 'revoked'; runId?: string; eventId?: string; detail?: string };
export type ResourceProposal = { revision: number; requestHash: string; resources: ResourceDirectory[]; scope: 'task' | 'project' };
export type ResourcePayload = ResourceProposal & {
  version: 1; launch: ResourceLaunch; source?: ResourceSource; purpose: string;
  projectPath?: string; application: ResourceApplication;
  hostIdentity: string; ownerKey: string; proposalHistory?: ResourceProposal[];
  decisions?: { revision: number; action: 'approve' | 'deny' | 'replace' | 'revoke'; actorOpenId: string; at: string }[];
  applicationHistory?: ResourceApplication[];
  delivery?: { adminMessageId?: string; replyMessageId?: string };
};
export type ResourceApproval = {
  id: string; status: string; requesterOpenId: string; requesterChatId: string;
  cardMessageId: string | null; expiresAt: Date | null; payload: ResourcePayload;
};

export function parseResourceInputs(value: unknown): ResourceInput[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error('Request between 1 and 32 resource directories.');
  return value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string' || !path.isAbsolute(item.path) || item.path.includes('\0') || !['read', 'write'].includes(item.access)) {
      throw new Error('Resources require an absolute directory path and read or write access.');
    }
    if (path.resolve(item.path) === path.parse(item.path).root) throw new Error('Host root cannot be granted as a task resource.');
    return { path: item.path, access: item.access };
  });
}

export async function canonicalResourceDirectories(value: unknown): Promise<ResourceDirectory[]> {
  const directories = await Promise.all(parseResourceInputs(value).map(async input => {
    const canonicalPath = await realpath(input.path);
    if (canonicalPath === path.parse(canonicalPath).root) throw new Error('Host root cannot be granted as a task resource.');
    const info = await stat(canonicalPath, { bigint: true });
    if (!info.isDirectory()) throw new Error(`Resource is not a directory: ${input.path}`);
    return { ...input, canonicalPath, device: info.dev.toString(), inode: info.ino.toString() };
  }));
  const unique = new Map<string, ResourceDirectory>();
  for (const directory of directories) {
    const previous = unique.get(directory.canonicalPath);
    if (!previous || directory.access === 'write') unique.set(directory.canonicalPath, directory);
  }
  return Array.from(unique.values()).sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath));
}

export function directoryContains(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function verifyResourceDirectories(resources: ResourceDirectory[]) {
  const current = await canonicalResourceDirectories(resources);
  if (current.length !== resources.length || current.some((item, i) => item.canonicalPath !== resources[i].canonicalPath || item.device !== resources[i].device || item.inode !== resources[i].inode)) {
    throw new Error('Resource directory identity changed. Submit a new resource proposal.');
  }
}

export async function resourceHostIdentity() {
  const machine = await readFile('/etc/machine-id', 'utf8');
  return createHash('sha256').update(`${hostname()}:${machine.trim()}`).digest('hex');
}

export function resourcePrincipal(launch: ResourceLaunch) {
  if (!launch.taskId || launch.participants?.length !== 1 || launch.participants[0].executionBackend !== 'platform_local') {
    throw new Error('Resource approvals support exactly one platform-local task participant.');
  }
  const participant = launch.participants[0];
  if (!participant.gatewayId || !participant.harnessType || !participant.role) throw new Error('Resource participant identity is incomplete.');
  return [participant.executionBackend, participant.gatewayId, participant.harnessType, participant.role, participant.agentId || ''];
}

export function resourceIntentHash(payload: Pick<ResourcePayload, 'launch' | 'hostIdentity' | 'ownerKey' | 'resources' | 'scope' | 'projectPath' | 'purpose'>) {
  return createHash('sha256').update(JSON.stringify({ taskId: payload.launch.taskId, principal: resourcePrincipal(payload.launch), host: payload.hostIdentity,
    owner: payload.ownerKey, resources: payload.resources.map(({ canonicalPath, device, inode, access }) => ({ canonicalPath, device, inode, access })),
    scope: payload.scope, projectPath: payload.projectPath, purpose: payload.purpose })).digest('hex');
}

export function resourceCovers(grant: ResourceDirectory, requested: ResourceDirectory) {
  return (grant.access === 'write' || requested.access === 'read') && directoryContains(grant.canonicalPath, requested.canonicalPath);
}
