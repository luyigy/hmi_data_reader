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

/**
 * WebSocket endpoint handed to runners. Derived from the origin the runner
 * actually reached (tunnel IP, LAN IP, or reverse proxy) so the address is
 * routable from wherever the runner lives. REMOTE_RUNNER_PUBLIC_URL overrides
 * with a full URL (e.g. behind an external proxy); otherwise the gateway port
 * (REMOTE_RUNNER_GATEWAY_PORT, default 3012) is combined with the request host.
 */
/**
 * Origin the client actually reached us on. Next dev reconstructs request.url
 * from the listen address (e.g. http://0.0.0.0:3010), which is unroutable for
 * runners, so prefer x-forwarded-host / Host headers when present.
 */
export const requestOrigin = (request: Request): string => {
  const headerOrigin = (name: string) => request.headers.get(name)?.split(',')[0]?.trim();
  const host = headerOrigin('x-forwarded-host') || request.headers.get('host')?.trim()
    || new URL(request.url).host;
  const proto = headerOrigin('x-forwarded-proto')
    || (host.endsWith(':443') ? 'https' : new URL(request.url).protocol.replace(':', ''));
  return `${proto}://${host}`;
};

export type RunnerServerUrlEnv = {
  [key: string]: string | undefined;
  REMOTE_RUNNER_PUBLIC_URL?: string | undefined;
  REMOTE_RUNNER_GATEWAY_PORT?: string | undefined;
};

export const resolveRunnerServerUrl = (
  origin: string,
  env: RunnerServerUrlEnv = process.env,
): string => {
  const url = new URL(origin);
  const override = env.REMOTE_RUNNER_PUBLIC_URL?.trim();
  const gatewayPort = env.REMOTE_RUNNER_GATEWAY_PORT?.trim() || '3012';
  return `${(override || `${url.protocol}//${url.hostname}:${gatewayPort}`)
    .replace(/^http:/, 'ws:')
    .replace(/^https:/, 'wss:')
    .replace(/\/+$/, '')}/runner`;
};

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
