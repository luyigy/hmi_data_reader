import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import type { AuthUser } from '@/lib/auth-users';

const TTL_MS = 10 * 60 * 1000;
const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export class PairingTicketError extends Error {
  constructor(message: string, public readonly status: 400 | 409 | 410) {
    super(message);
    this.name = 'PairingTicketError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export async function createPairingTicket(user: AuthUser) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TTL_MS);
  const ownerUserId = user.id === 'admin' ? null : user.id;
  await prisma.$transaction([
    prisma.pairingTicket.deleteMany({ where: { ownerUserId, consumedAt: null } }),
    prisma.pairingTicket.create({ data: { tokenHash: hash(token), ownerUserId, expiresAt } }),
  ]);
  return { token, expiresAt };
}

export async function claimPairingTicket(token: string, requestedName: string) {
  const ticket = await prisma.pairingTicket.findUnique({ where: { tokenHash: hash(token) } });
  if (!ticket) throw new PairingTicketError('Invalid pairing ticket', 400);
  if (ticket.consumedAt) throw new PairingTicketError('Pairing ticket already used', 409);
  if (ticket.expiresAt <= new Date()) throw new PairingTicketError('Pairing ticket expired', 410);

  const baseName = requestedName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'local-computer';
  const nodeName = `${baseName}-${crypto.randomBytes(4).toString('hex')}`;
  const nodeSecret = crypto.randomBytes(32).toString('hex');
  const secretHash = hash(nodeSecret);
  const consumedAt = new Date();

  const node = await prisma.$transaction(async (tx) => {
    const consumed = await tx.pairingTicket.updateMany({
      where: { id: ticket.id, consumedAt: null, expiresAt: { gt: consumedAt } },
      data: { consumedAt },
    });
    if (consumed.count !== 1) throw new PairingTicketError('Pairing ticket already used or expired', 409);
    return tx.remoteNode.create({
      data: { name: nodeName, host: 'unconnected', secretHash, ownerUserId: ticket.ownerUserId },
    });
  });
  return { nodeName: node.name, nodeSecret };
}
