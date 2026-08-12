import { prisma } from '@/lib/prisma';
import crypto from 'crypto';

export interface RemoteNodeInfo {
  id: string;
  name: string;
  host: string;
  status: 'online' | 'offline';
  lastSeen: Date | null;
}

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
    return { id: node.id, name: node.name, host: node.host, status: node.status as 'online' | 'offline', lastSeen: node.lastSeen };
  }

  const node = await prisma.remoteNode.create({
    data: { name, host, secretHash, status: 'online', lastSeen: new Date(), metadata: metadata ? JSON.stringify(metadata) : undefined },
  });
  return { id: node.id, name: node.name, host: node.host, status: node.status as 'online' | 'offline', lastSeen: node.lastSeen };
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
export async function listRemoteNodes(): Promise<RemoteNodeInfo[]> {
  const nodes = await prisma.remoteNode.findMany({ orderBy: { name: 'asc' } });
  return nodes.map(n => ({
    id: n.id,
    name: n.name,
    host: n.host,
    status: n.status as 'online' | 'offline',
    lastSeen: n.lastSeen,
  }));
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
