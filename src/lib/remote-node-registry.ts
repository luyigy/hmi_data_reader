import { prisma } from '@/lib/prisma';
import crypto from 'crypto';
import type { AuthUser } from '@/lib/auth-users';

export interface RemoteNodeInfo {
  id: string;
  name: string;
  host: string;
  status: 'online' | 'offline';
  lastSeen: Date | null;
  /** Non-sensitive runner metadata reported via the `hello` frame. */
  harnesses: string[];
  workspace: string | null;
}

/** Extract only the non-sensitive display fields from stored node metadata;
 * the node secret hash is never surfaced through this type. */
const parseNodeMetadata = (metadata: string | null): { harnesses: string[]; workspace: string | null } => {
  if (!metadata) return { harnesses: [], workspace: null };
  try {
    const parsed = JSON.parse(metadata) as { harnesses?: unknown; workspace?: unknown };
    const harnesses = Array.isArray(parsed.harnesses)
      ? parsed.harnesses.filter((value): value is string => typeof value === 'string')
      : [];
    const workspace = typeof parsed.workspace === 'string' && parsed.workspace.trim()
      ? parsed.workspace
      : null;
    return { harnesses, workspace };
  } catch {
    return { harnesses: [], workspace: null };
  }
};

type RemoteNodeRecord = { id: string; name: string; host: string; status: string; lastSeen: Date | null; metadata: string | null };

const toRemoteNodeInfo = (node: RemoteNodeRecord): RemoteNodeInfo => ({
  id: node.id,
  name: node.name,
  host: node.host,
  status: node.status === 'online' ? 'online' : 'offline',
  lastSeen: node.lastSeen,
  ...parseNodeMetadata(node.metadata),
});

/** Create or rotate credentials for a node before its first connection. */
export async function provisionNode(name: string, secret: string): Promise<void> {
  const normalizedName = name.trim();
  if (!normalizedName || !secret.trim()) throw new Error('Node name and secret are required');
  const secretHash = crypto.createHash('sha256').update(secret).digest('hex');
  await prisma.remoteNode.upsert({
    where: { name: normalizedName },
    create: { name: normalizedName, host: 'unconnected', secretHash, status: 'offline' },
    update: { secretHash, status: 'offline' },
  });
}

/** Register a remote node or update its heartbeat */
export async function registerNode(
  name: string,
  host: string,
  secret: string,
  metadata?: Record<string, unknown>
): Promise<RemoteNodeInfo> {
  const secretHash = crypto.createHash('sha256').update(secret).digest('hex');

  const existing = await prisma.remoteNode.findUnique({ where: { name } });
  if (existing) {
    const node = await prisma.remoteNode.update({
      where: { name },
      data: { host, status: 'online', lastSeen: new Date(), metadata: metadata ? JSON.stringify(metadata) : undefined },
    });
    return toRemoteNodeInfo(node);
  }

  const node = await prisma.remoteNode.create({
    data: { name, host, secretHash, status: 'online', lastSeen: new Date(), metadata: metadata ? JSON.stringify(metadata) : undefined },
  });
  return toRemoteNodeInfo(node);
}

/** Mark a node as offline */
export async function markNodeOffline(name: string): Promise<void> {
  await prisma.remoteNode.updateMany({ where: { name }, data: { status: 'offline' } });
}

const remoteNodeRoleMarker = (name: string) => `__remote_host__:remote-node:${name}`;

export async function markRemoteNodeMembersOnline(name: string): Promise<void> {
  await prisma.liveRoomMember.updateMany({
    where: { backend: 'remote_ssh', roleLabel: { contains: remoteNodeRoleMarker(name) }, presenceStatus: 'offline' },
    data: { presenceStatus: 'online' },
  });
}

export async function markRemoteNodeMembersOffline(name: string): Promise<void> {
  await prisma.liveRoomMember.updateMany({
    where: { backend: 'remote_ssh', roleLabel: { contains: remoteNodeRoleMarker(name) } },
    data: { presenceStatus: 'offline' },
  });
}

/** Get all registered nodes */
export async function listRemoteNodes(user?: AuthUser): Promise<RemoteNodeInfo[]> {
  const nodes = await prisma.remoteNode.findMany({
    where: user?.role === 'user' ? { ownerUserId: user.id } : undefined,
    orderBy: { name: 'asc' },
  });
  return nodes.map(toRemoteNodeInfo);
}

export async function getRemoteNodeName(id: string, user: AuthUser): Promise<string | null> {
  const node = await prisma.remoteNode.findFirst({
    where: { id, ...(user.role === 'admin' ? {} : { ownerUserId: user.id }) },
    select: { name: true },
  });
  return node?.name ?? null;
}

export async function removeOfflineRemoteNode(id: string, user: AuthUser): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const where = { id, status: 'offline', ...(user.role === 'admin' ? {} : { ownerUserId: user.id }) };
    const node = await tx.remoteNode.findFirst({ where, select: { name: true } });
    if (!node) return false;

    const result = await tx.remoteNode.deleteMany({ where });
    if (result.count !== 1) return false;

    await tx.liveRoomMember.updateMany({
      where: { backend: 'remote_ssh', roleLabel: { contains: remoteNodeRoleMarker(node.name) } },
      data: { joinStatus: 'removed', canReply: false, presenceStatus: 'offline' },
    });
    return true;
  });
}

export async function getRemoteNodeWorkspace(name: string): Promise<string | null> {
  const node = await prisma.remoteNode.findUnique({ where: { name }, select: { metadata: true } });
  if (!node?.metadata) return null;
  try {
    const workspace = (JSON.parse(node.metadata) as { workspace?: unknown }).workspace;
    return typeof workspace === 'string' && workspace.trim() ? workspace : null;
  } catch {
    return null;
  }
}

/** Verify node secret */
export async function verifyNodeSecret(name: string, secret: string): Promise<boolean> {
  const node = await prisma.remoteNode.findUnique({ where: { name } });
  if (!node) return false;
  const expectedHash = crypto.createHash('sha256').update(secret).digest('hex');
  return node.secretHash === expectedHash;
}

/** Remove stale offline nodes */
export async function cleanupStaleNodes(maxOfflineHours: number = 24): Promise<number> {
  const cutoff = new Date(Date.now() - maxOfflineHours * 3600 * 1000);
  const result = await prisma.remoteNode.deleteMany({
    where: { status: 'offline', lastSeen: { lt: cutoff } },
  });
  return result.count;
}
